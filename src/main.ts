import * as core from '@actions/core'
import * as github from '@actions/github'
import * as artifact from '@actions/artifact'
import type {Endpoints} from '@octokit/types'
import {GitHub} from '@actions/github/lib/utils'
import micromatch from 'micromatch'
import parseJson from 'parse-json'
import yaml from 'js-yaml'
import * as fs from 'node:fs/promises'
import {z} from 'zod'
import JSZip from 'jszip'
import {compress, decompress} from 'compress-json'

type ApiWorkflowRun =
  Endpoints['GET /repos/{owner}/{repo}/actions/runs/{run_id}']['response']['data']
type ApiWorkflowRuns =
  Endpoints['GET /repos/{owner}/{repo}/actions/runs']['response']['data']['workflow_runs'][number]
type ApiCommit =
  Endpoints['GET /repos/{owner}/{repo}/commits/{ref}']['response']['data']

const WorkflowRunTriggerType = z.enum([
  'pull_request',
  'push',
  'workflow_dispatch',
  'schedule',
  'release'
])
type WorkflowRunTrigger = z.infer<typeof WorkflowRunTriggerType>

const WorkflowRunStatusType = z.enum(['queued', 'in_progress', 'completed'])
type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusType>

const WorkflowRunConclusionType = z.enum([
  'success',
  'failure',
  'neutral',
  'cancelled',
  'skipped',
  'timed_out'
])
type WorkflowRunConclusion = z.infer<typeof WorkflowRunConclusionType>

const ChangedFilesType = z.array(z.array(z.string()))
type ChangedFiles = z.infer<typeof ChangedFilesType>

const ArtifactPathsResultType = z.object({
  should_skip: z.boolean().nullable(),
  backtrack_count: z.number(),
  skipped_by: z.optional(z.number()),
  matched_files: z.optional(z.array(z.string()))
})
type ArtifactPathsResult = z.infer<typeof ArtifactPathsResultType>

const ArtifactResultType = z.object({
  should_skip: z.boolean(),
  reason: z.string(),
  skipped_by: z.optional(z.number()),
  paths_result: z.optional(z.record(z.string(), ArtifactPathsResultType)),
  changed_files: z.optional(ChangedFilesType)
})
type ArtifactResult = z.infer<typeof ArtifactResultType>

const ArtifactRunsType = z.record(
  /** Run ID */
  z.number(),
  z.object({
    /** Tree Hash */
    t: z.optional(z.string()),
    /** Result */
    r: ArtifactResultType
  })
)
type ArtifactRuns = z.infer<typeof ArtifactRunsType>
type ArtifactRun = ArtifactRuns[number]

const ArtifactDataType = z
  .object({
    /* Version */
    v: z.literal(1),
    /* Workflow Runs */
    r: ArtifactRunsType
  })
  .strict()
type ArtifactData = z.infer<typeof ArtifactDataType>

interface WorkflowRun {
  id: number
  runNumber: number
  event: WorkflowRunTrigger
  treeHash: string
  commitHash: string
  status: WorkflowRunStatus | null
  conclusion: WorkflowRunConclusion | null
  htmlUrl: string
  branch: string | null
  repo: string
  workflowId: number
  createdAt: string
}

const PathsFilterType = z.record(
  z.string(),
  z.object({
    paths_ignore: z.array(z.string()).default([]),
    paths: z.array(z.string()).default([]),
    backtracking: z.union([z.boolean(), z.number()]).default(true)
  })
)
type PathsFilter = z.infer<typeof PathsFilterType>

type PathsResultType = Record<
  string,
  Omit<ArtifactPathsResult, 'skipped_by'> & {skipped_by?: WorkflowRun}
>

class PathsResult {
  #pathsResult: PathsResultType = {}
  #unknownFilters = new Set<string>()
  addFilter(name: string): void {
    this.#pathsResult[name] = {should_skip: null, backtrack_count: 0}
    this.#unknownFilters.add(name)
  }
  updateFilter(
    name: string,
    properties: Partial<PathsResultType[string]>
  ): void {
    Object.assign(this.#pathsResult[name], properties)
    if (this.#pathsResult[name].should_skip !== null) {
      this.#unknownFilters.delete(name)
    }
  }
  getFilter(name: string): PathsResultType[string] {
    return this.#pathsResult[name]
  }
  getUnknownFilters(): IterableIterator<string> {
    return this.#unknownFilters.values()
  }
  hasUnknownFilters(): boolean {
    return this.#unknownFilters.size > 0
  }
  get output(): PathsResultType {
    return this.#pathsResult
  }
  get artifact(): Record<string, ArtifactPathsResult> {
    return Object.entries(this.#pathsResult).reduce(
      (accumulator, [key, value]) => {
        accumulator[key] = (
          value.skipped_by ? {...value, skipped_by: value.skipped_by.id} : value
        ) as ArtifactPathsResult
        return accumulator
      },
      {} as Record<string, ArtifactPathsResult>
    )
  }
}

type ResultOutput = Omit<ArtifactResult, 'skipped_by' | 'paths_result'> & {
  skipped_by?: WorkflowRun
  paths_result?: PathsResultType
}
type ResultInput = Omit<ResultOutput, 'paths_result'> & {
  paths_result?: PathsResult
}

class Result {
  constructor(private readonly result: ResultInput) {}
  get output(): ResultOutput {
    return {
      ...this.result,
      ...(this.result.paths_result && {
        paths_result: this.result.paths_result.output
      })
    } as ResultOutput
  }
  get artifact(): ArtifactResult {
    return {
      ...this.result,
      ...(this.result.skipped_by && {skipped_by: this.result.skipped_by.id}),
      ...(this.result.paths_result && {
        paths_result: this.result.paths_result.artifact
      })
    } as ArtifactResult
  }
}

const ConcurrentSkippingType = z.enum([
  'always',
  'same_content',
  'same_content_newer',
  'outdated_runs',
  'never'
])

const InputsType = z.object({
  paths: z.array(z.string()),
  paths_ignore: z.array(z.string()),
  paths_filter: PathsFilterType,
  do_not_skip: z.array(WorkflowRunTriggerType),
  concurrent_skipping: ConcurrentSkippingType,
  cancel_others: z.boolean(),
  skip_after_successful_duplicates: z.boolean()
})
type Inputs = z.infer<typeof InputsType>

type Context = {
  repo: {owner: string; repo: string}
  octokit: InstanceType<typeof GitHub>
  currentRun: WorkflowRun
  allRuns: WorkflowRun[]
  olderRuns: WorkflowRun[]
  artifactRuns: Map<WorkflowRun, ArtifactRun>
  artifactIds: number[]
}

const ARTIFACT_FILE_NAME = 'data.json'
const getArtifactName = (workflowId: number): string =>
  `skip-duplicate-actions-${workflowId}-${github.context.job}-${github.context.action}`

class SkipDuplicateActions {
  globOptions = {
    dot: true // Match dotfiles. Otherwise dotfiles are ignored unless a "." is explicitly defined in the pattern.
  }

  constructor(
    private readonly inputs: Inputs,
    private readonly context: Context
  ) {}

  async run(): Promise<void> {
    // Cancel outdated runs.
    if (this.inputs.cancel_others) {
      await this.cancelOutdatedRuns()
    }

    // Abort early if current run has been triggered by an event that should never be skipped.
    if (this.inputs.do_not_skip.includes(this.context.currentRun.event)) {
      core.info(
        `Do not skip execution because the workflow was triggered with '${this.context.currentRun.event}'`
      )
      await this.exitSuccess({
        should_skip: false,
        reason: 'do_not_skip'
      })
    }

    // Skip on successful duplicate run.
    if (this.inputs.skip_after_successful_duplicates) {
      const successfulDuplicateRun = this.findSuccessfulDuplicateRun(
        this.context.currentRun.event === 'pull_request'
          ? this.context.artifactRuns.get(this.context.currentRun)?.t
          : this.context.currentRun.treeHash
      )
      if (successfulDuplicateRun) {
        core.info(
          `Skip execution because the exact same files have been successfully checked in run ${successfulDuplicateRun.htmlUrl}`
        )
        await this.exitSuccess({
          should_skip: true,
          reason: 'skip_after_successful_duplicate',
          skipped_by: successfulDuplicateRun
        })
      }
    }

    // Skip on concurrent runs.
    if (this.inputs.concurrent_skipping !== 'never') {
      const concurrentRun = this.detectConcurrentRuns()
      if (concurrentRun) {
        await this.exitSuccess({
          should_skip: true,
          reason: 'concurrent_skipping',
          skipped_by: concurrentRun
        })
      }
    }

    // Skip on path matches.
    if (
      this.inputs.paths.length >= 1 ||
      this.inputs.paths_ignore.length >= 1 ||
      Object.keys(this.inputs.paths_filter).length >= 1
    ) {
      const {pathsResult, changedFiles} = await this.backtracePathSkipping()
      const globalPathsResult = pathsResult.getFilter('global')
      await this.exitSuccess({
        should_skip:
          globalPathsResult.should_skip === null
            ? false
            : globalPathsResult.should_skip,
        reason: 'paths',
        ...(globalPathsResult.skipped_by && {
          skipped_by: globalPathsResult.skipped_by
        }),
        paths_result: pathsResult,
        changed_files: changedFiles
      })
    }

    // Do not skip otherwise.
    core.info(
      'Do not skip execution because no transferable run could be found'
    )
    await this.exitSuccess({
      should_skip: false,
      reason: 'no_transferable_run'
    })
  }

  async cancelOutdatedRuns(): Promise<void> {
    const cancelVictims = this.context.olderRuns.filter(run => {
      // Only cancel runs which are not yet completed.
      if (run.status === 'completed') {
        return false
      }
      // Only cancel runs from same branch and repo (ignore pull request runs from remote repositories)
      // and not with same tree hash.
      // See https://github.com/fkirc/skip-duplicate-actions/pull/177.
      return (
        run.treeHash !== this.context.currentRun.treeHash &&
        run.branch === this.context.currentRun.branch &&
        run.repo === this.context.currentRun.repo
      )
    })
    if (!cancelVictims.length) {
      return core.info('Did not find other workflow runs to be cancelled')
    }
    for (const victim of cancelVictims) {
      try {
        const res = await this.context.octokit.rest.actions.cancelWorkflowRun({
          ...this.context.repo,
          run_id: victim.id
        })
        core.info(
          `Cancelled run ${victim.htmlUrl} with response code ${res.status}`
        )
      } catch (error) {
        core.warning(
          composeErrorMessage({
            title: `Failed to cancel run ${victim.htmlUrl}`,
            error
          })
        )
      }
    }
  }

  findSuccessfulDuplicateRun(
    treeHash: string | undefined
  ): WorkflowRun | undefined {
    if (!treeHash) {
      return
    }
    // TODO Assign tree hash from artifact data for pull request runs. Ignore the run if the hash is not available.
    return this.context.olderRuns.find(run => {
      const runTreeHash =
        run.event === 'pull_request'
          ? this.context.artifactRuns.get(run)?.t
          : run.treeHash
      return (
        runTreeHash === treeHash &&
        run.status === 'completed' &&
        run.conclusion === 'success'
      )
    })
  }

  detectConcurrentRuns(): WorkflowRun | undefined {
    const concurrentRuns = this.context.allRuns.filter(
      run => run.status !== 'completed'
    )

    if (!concurrentRuns.length) {
      core.info('Did not find any concurrent workflow runs')
      return
    }
    if (this.inputs.concurrent_skipping === 'always') {
      core.info(
        `Skip execution because another instance of the same workflow is already running in ${concurrentRuns[0].htmlUrl}`
      )
      return concurrentRuns[0]
    } else if (this.inputs.concurrent_skipping === 'outdated_runs') {
      const newerRun = concurrentRuns.find(
        run =>
          new Date(run.createdAt).getTime() >
          new Date(this.context.currentRun.createdAt).getTime()
      )
      if (newerRun) {
        core.info(
          `Skip execution because a newer instance of the same workflow is running in ${newerRun.htmlUrl}`
        )
        return newerRun
      }
    } else if (this.inputs.concurrent_skipping === 'same_content') {
      const concurrentDuplicate = concurrentRuns.find(
        run => run.treeHash === this.context.currentRun.treeHash
      )
      if (concurrentDuplicate) {
        core.info(
          `Skip execution because the exact same files are concurrently checked in run ${concurrentDuplicate.htmlUrl}`
        )
        return concurrentDuplicate
      }
    } else if (this.inputs.concurrent_skipping === 'same_content_newer') {
      const concurrentIsOlder = concurrentRuns.find(
        run =>
          run.treeHash === this.context.currentRun.treeHash &&
          run.runNumber < this.context.currentRun.runNumber
      )
      if (concurrentIsOlder) {
        core.info(
          `Skip execution because the exact same files are concurrently checked in older run ${concurrentIsOlder.htmlUrl}`
        )
        return concurrentIsOlder
      }
    }
    core.info(`Did not find any concurrent workflow runs that justify skipping`)
  }

  async backtracePathSkipping(): Promise<{
    pathsResult: PathsResult
    changedFiles: ChangedFiles
  }> {
    let commit: ApiCommit | undefined
    let iterSha: string | undefined = this.context.currentRun.commitHash
    let distanceToHEAD = 0
    const allChangedFiles: ChangedFiles = []

    // The global paths settings are added under a "global" filter.
    const pathsFilter: PathsFilter = {
      ...this.inputs.paths_filter,
      global: {
        paths: this.inputs.paths,
        paths_ignore: this.inputs.paths_ignore,
        backtracking: true
      }
    }

    // Add all defined filters to the result.
    const pathsResult = new PathsResult()
    for (const name of Object.keys(pathsFilter)) {
      pathsResult.addFilter(name)
    }

    do {
      commit = await this.fetchCommitDetails(iterSha)
      if (!commit) {
        break
      }
      iterSha = commit.parents.length ? commit.parents[0].sha : undefined
      const changedFiles = commit.files
        ? commit.files
            .map(file => file.filename)
            .filter(file => typeof file === 'string')
        : []
      allChangedFiles.push(changedFiles)

      const successfulRun =
        (distanceToHEAD > 0 &&
          this.findSuccessfulDuplicateRun(commit.commit.tree.sha)) ||
        undefined

      for (const name of pathsResult.getUnknownFilters()) {
        // Skip if paths were ignorable or skippable until now and there is a successful run for the current commit.
        if (successfulRun) {
          pathsResult.updateFilter(name, {
            should_skip: true,
            skipped_by: successfulRun,
            backtrack_count: distanceToHEAD
          })
          core.info(
            `Skip '${name}' because all changes since run ${successfulRun.htmlUrl} are in ignored or skipped paths`
          )
          continue
        }

        // Check if backtracking limit has been reached.
        if (
          (pathsFilter[name].backtracking === false && distanceToHEAD === 1) ||
          pathsFilter[name].backtracking === distanceToHEAD
        ) {
          pathsResult.updateFilter(name, {
            should_skip: false,
            backtrack_count: distanceToHEAD
          })
          core.info(
            `Stop backtracking for '${name}' because the defined limit has been reached`
          )
          continue
        }

        // Ignorable if all changed files match against ignored paths.
        if (
          this.isCommitPathsIgnored(
            changedFiles,
            pathsFilter[name].paths_ignore
          )
        ) {
          core.info(
            `Commit ${commit.html_url} is path-ignored for '${name}': All of '${changedFiles}' match against patterns '${pathsFilter[name].paths_ignore}'`
          )
          continue
        }

        // Skippable if none of the changed files matches against paths.
        if (pathsFilter[name].paths.length >= 1) {
          const matches = this.getCommitPathsMatches(
            changedFiles,
            pathsFilter[name].paths
          )
          if (matches.length === 0) {
            core.info(
              `Commit ${commit.html_url} is path-skipped for '${name}': None of '${changedFiles}' matches against patterns '${pathsFilter[name].paths}'`
            )
            continue
          } else {
            pathsResult.updateFilter(name, {
              matched_files: matches
            })
          }
        }

        // Not ignorable or skippable.
        pathsResult.updateFilter(name, {
          should_skip: false,
          backtrack_count: distanceToHEAD
        })
        core.info(
          `Stop backtracking for '${name}' at commit ${commit.html_url} because '${changedFiles}' are not skippable against paths '${pathsFilter[name].paths}' or paths_ignore '${pathsFilter[name].paths_ignore}'`
        )
      }

      // Should be never reached in practice; this loop is expected to abort after 1-3 iterations.
      if (distanceToHEAD++ >= 50) {
        core.warning(
          'Aborted commit-backtracing due to bad performance - Did you push an excessive number of ignored-path commits?'
        )
        break
      }
    } while (pathsResult.hasUnknownFilters())

    return {pathsResult, changedFiles: allChangedFiles}
  }

  isCommitPathsIgnored(changedFiles: string[], pathsIgnore: string[]): boolean {
    if (pathsIgnore.length === 0) {
      return false
    }
    const notIgnoredPaths = micromatch.not(
      changedFiles,
      pathsIgnore,
      this.globOptions
    )
    return notIgnoredPaths.length === 0
  }

  getCommitPathsMatches(changedFiles: string[], paths: string[]): string[] {
    const matches = micromatch(changedFiles, paths, this.globOptions)
    return matches
  }

  async fetchCommitDetails(sha?: string): Promise<ApiCommit | undefined> {
    if (!sha) {
      return undefined
    }
    try {
      return (
        await this.context.octokit.rest.repos.getCommit({
          ...this.context.repo,
          ref: sha
        })
      ).data
    } catch (error) {
      core.warning(
        composeErrorMessage({title: `Failed to retrieve commit ${sha}`, error})
      )
      return undefined
    }
  }

  /** Set all outputs and exit the action. */
  async exitSuccess(result: ResultInput): Promise<never> {
    const tasks = []

    // Generate job summary.
    const {output: outputResult, artifact: artifactResult} = new Result(result)
    const summary = [
      '<h2><a href="https://github.com/fkirc/skip-duplicate-actions">Skip Duplicate Actions</a></h2>',
      '<details open><summary><b>Should Skip</b></summary><table><tr>',
      `<td>${outputResult.should_skip ? 'Yes' : 'No'}</td>`,
      `<td><code>${outputResult.should_skip}</code></td>`,
      '</tr></table></details>',
      '<details open><summary><b>Reason</b></summary><table><tr>',
      `<td><code>${outputResult.reason}</code></td>`,
      '</tr></table></details>'
    ]
    if (outputResult.skipped_by) {
      summary.push(
        '<details><summary><b>Skipped By</b></summary><table><tr>',
        `<th><a href="${outputResult.skipped_by.htmlUrl}">${outputResult.skipped_by.runNumber}</a></th>`,
        `<td><pre lang="json">${JSON.stringify(
          outputResult.skipped_by,
          null,
          2
        )}</pre></td>`,
        '</tr></table></details>'
      )
    }
    if (outputResult.paths_result) {
      summary.push(
        '<details><summary><b>Paths Result</b></summary><table><tr>',
        `<td><pre lang="json">${JSON.stringify(
          outputResult.paths_result,
          null,
          2
        )}</pre></td>`,
        '</tr></table></details>'
      )
    }
    if (outputResult.changed_files) {
      summary.push(
        '<details><summary><b>Changed Files</b></summary><table>',
        outputResult.changed_files
          .map(
            (commit, index) =>
              `<tr><th>${index}</th><td><ul>${commit
                .map(file => `<li><code>${file}</code></li>`)
                .join('')}</ul></td></tr>`
          )
          .join(''),
        '</table></details>'
      )
    }
    tasks.push(core.summary.addRaw(summary.join('')).write())

    // Prepare artifact data.
    const artifactRuns: ArtifactRuns = {}
    this.context.artifactRuns.set(this.context.currentRun, {
      ...this.context.artifactRuns.get(this.context.currentRun),
      r: artifactResult
    })
    for (const [key, value] of this.context.artifactRuns) {
      artifactRuns[key.id] = value
    }
    const artifactData: ArtifactData = {
      v: 1,
      r: artifactRuns
    }
    try {
      // Upload artifact.
      await fs.writeFile(
        ARTIFACT_FILE_NAME,
        JSON.stringify(compress(artifactData))
      )
      const artifactClient = artifact.create()
      await core.group('Upload artifact data', async () => {
        await artifactClient.uploadArtifact(
          getArtifactName(this.context.currentRun.workflowId),
          [ARTIFACT_FILE_NAME],
          '.',
          // Reduce retention days a bit.
          {retentionDays: 60}
        )
      })
      // Try to remove older artifacts.
      // Only run if upload was successful and leave the last 4 artifacts for potential concurrent running workflows.
      for (const id of this.context.artifactIds.slice(4)) {
        tasks.push(
          this.context.octokit.rest.actions.deleteArtifact({
            ...this.context.repo,
            artifact_id: id
          })
        )
      }
    } catch (error) {
      core.warning(
        composeErrorMessage({title: 'Failed to upload artifact data', error})
      )
    }

    // Set all outputs.
    core.setOutput('should_skip', outputResult.should_skip)
    core.setOutput('reason', outputResult.reason)
    core.setOutput('skipped_by', outputResult.skipped_by || {})
    core.setOutput('paths_result', outputResult.paths_result || {})
    core.setOutput('changed_files', outputResult.changed_files || [])

    // Wait for all tasks to be finished (ignore errors).
    await Promise.allSettled(tasks)
    process.exit(0)
  }
}

async function main(): Promise<void> {
  // Get and validate inputs.
  let token: string
  let inputs: Inputs
  try {
    token = core.getInput('github_token', {required: true})
    inputs = InputsType.parse({
      paths: getJsonInput('paths'),
      paths_ignore: getJsonInput('paths_ignore'),
      paths_filter: getYamlInput('paths_filter'),
      do_not_skip: getJsonInput('do_not_skip'),
      concurrent_skipping: core.getInput('concurrent_skipping'),
      cancel_others: core.getBooleanInput('cancel_others'),
      skip_after_successful_duplicates: core.getBooleanInput(
        'skip_after_successful_duplicate'
      )
    })
  } catch (error) {
    exitFail(
      composeErrorMessage({
        title: 'Error with input values',
        error: error instanceof z.ZodError ? composeZodError(error) : error
      })
    )
  }

  // Get repo and octokit instance.
  const repo = github.context.repo
  const octokit = github.getOctokit(token)

  // Get and parse the current workflow run.
  const {data: apiCurrentRun} = await octokit.rest.actions.getWorkflowRun({
    ...repo,
    run_id: github.context.runId
  })
  const currentTreeHash = apiCurrentRun.head_commit?.tree_id
  if (!currentTreeHash) {
    exitFail(`
        Could not find the tree hash of run ${apiCurrentRun.id} (Workflow ID: ${apiCurrentRun.workflow_id},
        Name: ${apiCurrentRun.name}, Head Branch: ${apiCurrentRun.head_branch}, Head SHA: ${apiCurrentRun.head_sha}).
        This might be a run associated with a headless or removed commit.
      `)
  }
  const currentRun = mapWorkflowRun(apiCurrentRun, currentTreeHash)

  // TODO
  const artifactRuns = new Map<WorkflowRun, ArtifactRun>()

  // Add current run to artifact runs.
  const currentArtifactRun = {} as ArtifactRun
  // Get tree hash of the merge commit on pull request events.
  if (apiCurrentRun.event === 'pull_request') {
    const {data: commit} = await octokit.rest.repos.getCommit({
      ...repo,
      ref: github.context.sha
    })
    currentArtifactRun.t = commit.commit.tree.sha
  }
  artifactRuns.set(currentRun, currentArtifactRun)

  // Fetch list of runs for current workflow.
  const {
    data: {workflow_runs: apiAllRuns}
  } = await octokit.rest.actions.listWorkflowRuns({
    ...repo,
    workflow_id: currentRun.workflowId,
    per_page: 100
  })

  // Get and parse artifact data.
  let artifactIds: number[] = []
  let artifactData: ArtifactRuns = {}
  try {
    const {
      data: {artifacts: apiAllArtifacts}
    } = await octokit.rest.actions.listArtifactsForRepo({
      ...repo,
      per_page: 100
    })
    const artifactName = getArtifactName(currentRun.workflowId)
    const currentArtifacts = apiAllArtifacts.filter(
      item => item.name === artifactName
    )
    artifactIds = currentArtifacts.map(item => item.id)
    const latestArtifact = currentArtifacts[0]
    if (latestArtifact) {
      core.info(
        `Got artifact data from ${
          latestArtifact.workflow_run?.id
            ? `run ${latestArtifact.workflow_run.id}`
            : 'unknown run'
        }`
      )
      const {data: latestArtifactData} =
        await octokit.rest.actions.downloadArtifact({
          ...repo,
          artifact_id: latestArtifact.id,
          archive_format: 'zip'
        })
      const zip = await JSZip.loadAsync(
        Buffer.from(latestArtifactData as string),
        {
          base64: true
        }
      )
      const file = await zip.file(ARTIFACT_FILE_NAME)?.async('string')
      if (file) {
        artifactData = ArtifactDataType.parse(decompress(parseJson(file))).r
      }
    }
  } catch (error) {
    core.info(typeof error)
    if (error) {
      core.info(JSON.stringify(Object.getPrototypeOf(error)))
      core.info(JSON.stringify(error.constructor))
    }
    core.warning(
      composeErrorMessage({
        title: 'Failed to get artifact data',
        error: error instanceof z.ZodError ? composeZodError(error, 1) : error
      })
    )
  }

  // List with all workflow runs.
  const allRuns = []
  // List with older workflow runs only (used to prevent some nasty race conditions and edge cases).
  const olderRuns = []

  // Check and map all runs.
  for (const run of apiAllRuns) {
    // Filter out current run.
    if (run.id === currentRun.id) {
      continue
    }

    // Filter out runs that lack 'head_commit' (most likely runs associated with a headless or removed commit).
    // See https://github.com/fkirc/skip-duplicate-actions/pull/178.
    const treeHash = run.head_commit?.tree_id
    if (treeHash) {
      const mappedRun = mapWorkflowRun(run, treeHash)
      // Add to list of all runs.
      allRuns.push(mappedRun)

      // Check if run can be added to list of older runs.
      if (
        new Date(mappedRun.createdAt).getTime() <
        new Date(currentRun.createdAt).getTime()
      ) {
        olderRuns.push(mappedRun)
      }

      if (run.id in artifactData) {
        artifactRuns.set(mappedRun, artifactData[run.id])
      }
    }
  }

  const skipDuplicateActions = new SkipDuplicateActions(inputs, {
    repo,
    octokit,
    currentRun,
    allRuns,
    olderRuns,
    artifactRuns,
    artifactIds
  })
  await skipDuplicateActions.run()
}

/* Parse action input as JSON. */
function getJsonInput(name: string): unknown {
  const input = core.getInput(name)
  if (input) {
    return parseJson(core.getInput(name), name)
  }
  return undefined
}

/* Parse action input as YAML. */
function getYamlInput(name: string): unknown {
  return yaml.load(core.getInput(name), {filename: name})
}

/* Pick selected data from workflow run. */
function mapWorkflowRun(
  run: ApiWorkflowRun | ApiWorkflowRuns,
  treeHash: string
): WorkflowRun {
  return {
    id: run.id,
    runNumber: run.run_number,
    event: run.event as WorkflowRunTrigger,
    treeHash,
    commitHash: run.head_sha,
    status: run.status as WorkflowRunStatus,
    conclusion: run.conclusion as WorkflowRunConclusion,
    htmlUrl: run.html_url,
    branch: run.head_branch,
    // Wrong type: 'head_repository' can be null
    // (see https://github.com/github/rest-api-description/issues/1586)
    repo: run.head_repository?.full_name ?? null,
    workflowId: run.workflow_id,
    createdAt: run.created_at
  }
}

/** Compose Zod errors. */
function composeZodError(error: z.ZodError, limit?: number): string {
  const errors = []
  for (const issue of error.issues.slice(0, limit)) {
    let keyPath = ''
    for (const [index, key] of issue.path.entries()) {
      switch (typeof key) {
        case 'string':
          keyPath += `${index > 0 ? '.' : ''}${key}`
          break
        case 'number':
          keyPath += `[${key}]`
          break
      }
    }
    errors.push(`${keyPath ? `${keyPath}: ` : ''}${error.message}`)
  }
  return `${errors.join('\n').replace(/^/gm, errors.length > 1 ? '- ' : '')}`
}

/** Compose error message. */
function composeErrorMessage({
  title,
  error
}: {
  title?: string
  error: unknown
}): string {
  // Look for error message.
  let message = 'Unknown error'
  if (typeof error === 'string') {
    message = error
  }
  if (error instanceof Error && error.message) {
    message = error.message
  }
  // Prepend error message by the title.
  if (title) {
    return `${title}:\n${message.replace(/^/gm, '\t')}`
  }
  return message
}

/** Immediately terminate the action with failing exit code. */
function exitFail(error: unknown): never {
  if (error instanceof Error || typeof error == 'string') {
    core.error(error)
  }
  process.exit(1)
}

main()
