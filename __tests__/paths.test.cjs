const assert = require('node:assert/strict')
const {execFile} = require('node:child_process')
const {mkdtemp, readFile, rm, writeFile} = require('node:fs/promises')
const {createServer} = require('node:http')
const {tmpdir} = require('node:os')
const {join} = require('node:path')
const {test} = require('node:test')
const {promisify} = require('node:util')

const scenarios = [
  {
    name: 'rename out of included paths with an extension change',
    filename: 'docs/Service.txt',
    previous_filename: 'src/Service.cs',
    paths: ['src/**', '**/*.cs'],
    shouldSkip: false,
    matchedFiles: ['src/Service.cs']
  },
  {
    name: 'rename into included paths',
    filename: 'src/Service.cs',
    previous_filename: 'docs/Service.txt',
    paths: ['src/**', '**/*.cs'],
    shouldSkip: false,
    matchedFiles: ['src/Service.cs']
  },
  {
    name: 'rename into ignored paths still changes a nonignored source',
    filename: 'docs/Service.txt',
    previous_filename: 'src/Service.cs',
    pathsIgnore: ['docs/**'],
    shouldSkip: false
  },
  {
    name: 'rename out of ignored paths changes a nonignored destination',
    filename: 'src/Service.cs',
    previous_filename: 'docs/Service.txt',
    pathsIgnore: ['docs/**'],
    shouldSkip: false
  },
  {
    name: 'rename entirely within ignored paths can be skipped',
    filename: 'docs/after.txt',
    previous_filename: 'docs/before.txt',
    pathsIgnore: ['docs/**'],
    shouldSkip: true
  },
  {
    name: 'rename entirely outside included paths can be skipped',
    filename: 'docs/after.txt',
    previous_filename: 'docs/before.txt',
    paths: ['src/**', '**/*.cs'],
    shouldSkip: true
  },
  {
    name: 'ordinary change without a previous filename',
    filename: 'src/Service.cs',
    paths: ['src/**'],
    shouldSkip: false,
    matchedFiles: ['src/Service.cs']
  }
]

for (const scenario of scenarios) {
  test(scenario.name, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'skip-duplicate-paths-'))
    t.after(() => rm(directory, {recursive: true, force: true}))
    const outputFile = join(directory, 'output')
    await writeFile(outputFile, '')

    const workflowRun = (id, sha, tree, createdAt) => ({
      id,
      run_number: id,
      event: 'push',
      head_sha: sha,
      head_commit: {tree_id: tree},
      status: id === 1 ? 'completed' : 'in_progress',
      conclusion: id === 1 ? 'success' : null,
      html_url: `https://github.com/fixture/repo/actions/runs/${id}`,
      head_branch: 'main',
      head_repository: {full_name: 'fixture/repo'},
      workflow_id: 123,
      created_at: createdAt
    })
    const currentRun = workflowRun(2, 'current', 'tree-current', '2026-01-02')
    const previousRun = workflowRun(
      1,
      'previous',
      'tree-previous',
      '2026-01-01'
    )
    const file = {
      filename: scenario.filename,
      previous_filename: scenario.previous_filename,
      status: scenario.previous_filename ? 'renamed' : 'modified'
    }
    const responses = {
      '/repos/fixture/repo/actions/runs/2': currentRun,
      '/repos/fixture/repo/actions/workflows/123/runs': {
        workflow_runs: [currentRun, previousRun]
      },
      '/repos/fixture/repo/commits/current': {
        sha: 'current',
        html_url: 'https://github.com/fixture/repo/commit/current',
        commit: {tree: {sha: 'tree-current'}},
        parents: [{sha: 'previous'}],
        files: [file]
      },
      '/repos/fixture/repo/commits/previous': {
        sha: 'previous',
        html_url: 'https://github.com/fixture/repo/commit/previous',
        commit: {tree: {sha: 'tree-previous'}},
        parents: [],
        files: []
      }
    }
    const unexpectedRequests = []
    const server = createServer((request, response) => {
      const data = responses[new URL(request.url, 'http://localhost').pathname]
      if (!data) unexpectedRequests.push(request.url)
      response.writeHead(data ? 200 : 404, {'content-type': 'application/json'})
      response.end(JSON.stringify(data || {message: 'Unexpected request'}))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => server.close(resolve)))

    const filter = {
      paths: scenario.paths || [],
      paths_ignore: scenario.pathsIgnore || []
    }
    await promisify(execFile)(process.execPath, ['dist/index.js'], {
      timeout: 10000,
      env: {
        ...process.env,
        GITHUB_REPOSITORY: 'fixture/repo',
        GITHUB_RUN_ID: '2',
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
        GITHUB_OUTPUT: outputFile,
        INPUT_GITHUB_TOKEN: 'fixture-token',
        INPUT_PATHS: JSON.stringify(filter.paths),
        INPUT_PATHS_IGNORE: JSON.stringify(filter.paths_ignore),
        INPUT_PATHS_FILTER: JSON.stringify({service: filter}),
        INPUT_CONCURRENT_SKIPPING: 'never',
        INPUT_SKIP_AFTER_SUCCESSFUL_DUPLICATE: 'true',
        INPUT_CANCEL_OTHERS: 'false',
        INPUT_DO_NOT_SKIP: '[]',
        INPUT_SKIP_SUMMARY: 'true'
      }
    })

    const outputLines = (await readFile(outputFile, 'utf8')).split(/\r?\n/)
    const output = name => {
      const start = outputLines.findIndex(line => line.startsWith(`${name}<<`))
      assert.notEqual(start, -1, `Missing output: ${name}`)
      const delimiter = outputLines[start].split('<<')[1]
      const end = outputLines.indexOf(delimiter, start + 1)
      return JSON.parse(outputLines.slice(start + 1, end).join('\n'))
    }
    assert.deepEqual(unexpectedRequests, [])
    assert.equal(output('should_skip'), scenario.shouldSkip)
    const results = output('paths_result')
    for (const name of ['global', 'service']) {
      assert.equal(results[name].should_skip, scenario.shouldSkip)
      assert.equal(results[name].backtrack_count, scenario.shouldSkip ? 1 : 0)
      if (scenario.matchedFiles) {
        assert.deepEqual(results[name].matched_files, scenario.matchedFiles)
      }
    }
    assert.deepEqual(output('changed_files')[0], [
      scenario.filename,
      ...(scenario.previous_filename ? [scenario.previous_filename] : [])
    ])
  })
}
