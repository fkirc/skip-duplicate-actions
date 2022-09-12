import * as core from '@actions/core'
import * as github from '@actions/github'
import type {Endpoints} from '@octokit/types'
import {GitHub} from '@actions/github/lib/utils'
import micromatch from 'micromatch'
import yaml from 'js-yaml'

type ActionsGetWorkflowRunResponseData =
  Endpoints['GET /repos/{owner}/{repo}/actions/runs/{run_id}']['response']['data']
type ActionsListWorkflowRunsResponseData =
  Endpoints['GET /repos/{owner}/{repo}/actions/runs']['response']['data']
type ReposGetCommitResponseData =
  Endpoints['GET /repos/{owner}/{repo}/commits/{ref}']['response']['data']

type WorkflowRunStatus = 'queued' | 'in_progress' | 'completed'
type WorkflowRunConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'

const concurrentSkippingMap = {
  always: null,
  same_content: null,
  same_content_newer: null,
  outdated_runs: null,
  never: null
}
function getConcurrentSkippingOptions(): string[] {
  return Object.keys(concurrentSkippingMap)
}
type ConcurrentSkippingOption = keyof typeof concurrentSkippingMap

interface WorkflowRun {
  event: WRunTrigger
  treeHash: string
  commitHash: string
  status: WorkflowRunStatus
  conclusion: WorkflowRunConclusion | null
  html_url: string
  branch: string | null
  repo: string | null
  runId: number
  workflowId: number
  createdAt: string
  runNumber: number
}

type WRunTrigger = 'pull_request' | 'push' | 'workflow_dispatch' | 'schedule'

interface PathsFilterEntry {
  paths_ignore: string[]
  paths: string[]
  backtracking: boolean | number
}
type PathsFilter = Record<string, PathsFilterEntry>

interface WRunContext {
  repoOwner: string
  repoName: string
  currentRun: WorkflowRun
  olderRuns: WorkflowRun[]
  allRuns: WorkflowRun[]
  octokit: InstanceType<typeof GitHub>
  pathsIgnore: string[]
  paths: string[]
  pathsFilter: PathsFilter
  doNotSkip: WRunTrigger[]
  concurrentSkipping: ConcurrentSkippingOption
}

interface PathsResultEntry {
  should_skip: 'unknown' | boolean
  backtrack_count: number
  skipped_by?: WorkflowRun
  matched_files?: string[]
}

type PathsResult = Record<string, PathsResultEntry>

function parseWorkflowRun(run: ActionsGetWorkflowRunResponseData): WorkflowRun {
  const treeHash = run.head_commit?.tree_id
  if (!treeHash) {
    logFatal(`
      Could not find the tree hash of run ${run.id} (workflow: $ {run.workflow_id},
      name: ${run.name}, head_branch: ${run.head_branch}, head_sha: ${run.head_sha}).
      You might have a run associated with a headless or removed commit.
    `)
  }
  const workflowId = run.workflow_id
  if (!workflowId) {
    logFatal(`Could not find the workflow ID of run ${run.id}`)
  }
  return {
    event: run.event as WRunTrigger,
    treeHash,
    commitHash: run.head_sha,
    status: run.status as WorkflowRunStatus,
    conclusion: (run.conclusion as WorkflowRunConclusion) ?? null,
    html_url: run.html_url,
    branch: run.head_branch ?? null,
    repo: run.head_repository.full_name ?? null,
    runId: run.id,
    workflowId,
    createdAt: run.created_at,
    runNumber: run.run_number
  }
}

function parseAllRuns(
  response: ActionsListWorkflowRunsResponseData
): WorkflowRun[] {
  return response.workflow_runs
    .filter(run => run.head_commit && run.workflow_id)
    .map(run => parseWorkflowRun(run))
}

function parseOlderRuns(
  response: ActionsListWorkflowRunsResponseData,
  currentRun: WorkflowRun
): WorkflowRun[] {
  const olderRuns = response.workflow_runs.filter(run => {
    // Only consider older workflow runs to prevent some nasty race conditions and edge cases.
    return (
      new Date(run.created_at).getTime() <
      new Date(currentRun.createdAt).getTime()
    )
  })
  return olderRuns
    .filter(run => run.head_commit && run.workflow_id)
    .map(run => parseWorkflowRun(run))
}

async function main(): Promise<void> {
  try {
    const token = core.getInput('github_token', {required: true})
    if (!token) {
      logFatal('Did not find github_token')
    }
    const repo = github.context.repo
    const repoOwner = repo?.owner
    if (!repoOwner) {
      logFatal('Did not find the repo owner')
    }
    const repoName = repo?.repo
    if (!repoName) {
      logFatal('Did not find the repo name')
    }
    const runId = github.context.runId
    if (!runId) {
      logFatal('Did not find runId')
    }

    let context: Readonly<WRunContext>
    try {
      const octokit = github.getOctokit(token)
      const {data: current_run} = await octokit.rest.actions.getWorkflowRun({
        owner: repoOwner,
        repo: repoName,
        run_id: runId
      })
      const currentRun = parseWorkflowRun(current_run)

      const {data} = await octokit.rest.actions.listWorkflowRuns({
        owner: repoOwner,
        repo: repoName,
        workflow_id: currentRun.workflowId,
        per_page: 100
      })
      context = {
        repoOwner,
        repoName,
        currentRun,
        olderRuns: parseOlderRuns(data, currentRun),
        allRuns: parseAllRuns(data),
        octokit,
        pathsIgnore: getStringArrayInput('paths_ignore'),
        paths: getStringArrayInput('paths'),
        pathsFilter: getPathsFilterInput('paths_filter'),
        doNotSkip: getStringArrayInput('do_not_skip') as WRunTrigger[],
        concurrentSkipping: getConcurrentSkippingInput('concurrent_skipping')
      }
    } catch (e) {
      if (e instanceof Error || typeof e === 'string') {
        core.warning(e)
      }
      core.warning('Failed to fetch the required workflow information')
      exitSuccess({
        shouldSkip: false,
        reason: 'no_workflow_information'
      })
    }

    const cancelOthers = getBooleanInput('cancel_others', false)
    if (cancelOthers) {
      await cancelOutdatedRuns(context)
    }
    if (context.doNotSkip.includes(context.currentRun.event)) {
      core.info(
        `Do not skip execution because the workflow was triggered with '${context.currentRun.event}'`
      )
      exitSuccess({
        shouldSkip: false,
        reason: 'do_not_skip'
      })
    }
    const skipAfterSuccessfulDuplicates = getBooleanInput(
      'skip_after_successful_duplicate',
      true
    )
    if (skipAfterSuccessfulDuplicates) {
      const successfulDuplicateRun = detectSuccessfulDuplicateRuns(context)
      if (successfulDuplicateRun) {
        core.info(
          `Skip execution because the exact same files have been successfully checked in run ${successfulDuplicateRun.html_url}`
        )
        exitSuccess({
          shouldSkip: true,
          reason: 'skip_after_successful_duplicate',
          skippedBy: successfulDuplicateRun
        })
      }
    }
    if (context.concurrentSkipping !== 'never') {
      const concurrentRun = detectConcurrentRuns(context)
      if (concurrentRun) {
        exitSuccess({
          shouldSkip: true,
          reason: 'concurrent_skipping',
          skippedBy: concurrentRun
        })
      }
    }
    if (
      context.paths.length >= 1 ||
      context.pathsIgnore.length >= 1 ||
      Object.keys(context.pathsFilter).length >= 1
    ) {
      const {changedFiles, pathsResult} = await backtracePathSkipping(context)
      exitSuccess({
        shouldSkip:
          pathsResult.global.should_skip === 'unknown'
            ? false
            : pathsResult.global.should_skip,
        reason: 'paths',
        skippedBy: pathsResult.global.skipped_by,
        changedFiles,
        pathsResult
      })
    }
    core.info(
      'Do not skip execution because we did not find a transferable run'
    )
    exitSuccess({
      shouldSkip: false,
      reason: 'no_transferable_run'
    })
  } catch (e) {
    if (e instanceof Error) {
      core.error(e)
      logFatal(e.message)
    }
  }
}

async function cancelOutdatedRuns(context: WRunContext): Promise<void> {
  const currentRun = context.currentRun
  const cancelVictims = context.olderRuns.filter(run => {
    if (run.status === 'completed') {
      return false
    }
    return (
      run.treeHash !== currentRun.treeHash &&
      run.branch === currentRun.branch &&
      run.repo === currentRun.repo
    )
  })
  if (!cancelVictims.length) {
    return core.info('Did not find other workflow runs to be cancelled')
  }
  for (const victim of cancelVictims) {
    await cancelWorkflowRun(victim, context)
  }
}

async function cancelWorkflowRun(
  run: WorkflowRun,
  context: WRunContext
): Promise<void> {
  try {
    const res = await context.octokit.rest.actions.cancelWorkflowRun({
      owner: context.repoOwner,
      repo: context.repoName,
      run_id: run.runId
    })
    core.info(`Cancelled run ${run.html_url} with response code ${res.status}`)
  } catch (e) {
    if (e instanceof Error || typeof e === 'string') {
      core.warning(e)
    }
    core.warning(`Failed to cancel ${run.html_url}`)
  }
}

function detectSuccessfulDuplicateRuns(
  context: WRunContext
): WorkflowRun | undefined {
  const duplicateRuns = context.olderRuns.filter(
    run => run.treeHash === context.currentRun.treeHash
  )
  const successfulDuplicate = duplicateRuns.find(run => {
    return run.status === 'completed' && run.conclusion === 'success'
  })
  return successfulDuplicate
}

function detectConcurrentRuns(context: WRunContext): WorkflowRun | undefined {
  const concurrentRuns: WorkflowRun[] = context.allRuns.filter(run => {
    if (run.status === 'completed') {
      return false
    }
    if (run.runId === context.currentRun.runId) {
      return false
    }
    return true
  })

  if (!concurrentRuns.length) {
    core.info(`Did not find any concurrent workflow runs`)
    return
  }
  if (context.concurrentSkipping === 'always') {
    core.info(
      `Skip execution because another instance of the same workflow is already running in ${concurrentRuns[0].html_url}`
    )
    return concurrentRuns[0]
  } else if (context.concurrentSkipping === 'outdated_runs') {
    const newerRun = concurrentRuns.find(
      run =>
        new Date(run.createdAt).getTime() >
        new Date(context.currentRun.createdAt).getTime()
    )
    if (newerRun) {
      core.info(
        `Skip execution because a newer instance of the same workflow is running in ${newerRun.html_url}`
      )
      return newerRun
    }
  } else if (context.concurrentSkipping === 'same_content') {
    const concurrentDuplicate = concurrentRuns.find(
      run => run.treeHash === context.currentRun.treeHash
    )
    if (concurrentDuplicate) {
      core.info(
        `Skip execution because the exact same files are concurrently checked in run ${concurrentDuplicate.html_url}`
      )
      return concurrentDuplicate
    }
  } else if (context.concurrentSkipping === 'same_content_newer') {
    const concurrentIsOlder = concurrentRuns.find(
      run =>
        run.treeHash === context.currentRun.treeHash &&
        run.runNumber < context.currentRun.runNumber
    )
    if (concurrentIsOlder) {
      core.info(
        `Skip execution because the exact same files are concurrently checked in older run ${concurrentIsOlder.html_url}`
      )
      return concurrentIsOlder
    }
  }
  core.info(`Did not find any concurrent workflow runs that justify skipping`)
}

async function backtracePathSkipping(
  context: WRunContext
): Promise<{changedFiles: string[][]; pathsResult: PathsResult}> {
  let commit: ReposGetCommitResponseData | null
  let iterSha: string | null = context.currentRun.commitHash
  let distanceToHEAD = 0
  const allChangedFiles: string[][] = []

  const pathsFilter: PathsFilter = {
    ...context.pathsFilter,
    global: {
      paths: context.paths,
      paths_ignore: context.pathsIgnore,
      backtracking: true
    }
  }

  const pathsResult: PathsResult = {}
  for (const name of Object.keys(pathsFilter)) {
    pathsResult[name] = {should_skip: 'unknown', backtrack_count: 0}
  }

  do {
    commit = await fetchCommitDetails(iterSha, context)
    if (!commit) {
      break
    }
    iterSha = commit.parents?.length ? commit.parents[0]?.sha : null
    const changedFiles = commit.files
      ? commit.files.map(f => f.filename).filter(f => typeof f === 'string')
      : []
    allChangedFiles.push(changedFiles)

    const successfulRun =
      (distanceToHEAD >= 1 &&
        findSuccessfulRun(commit.commit.tree.sha, context.olderRuns)) ||
      undefined

    for (const [name, values] of Object.entries(pathsResult)) {
      // Only process paths where status is not determined yet.
      if (values.should_skip !== 'unknown') continue

      // Skip if paths were ignorable or skippable until now and there is a successful run on the current commit.
      if (successfulRun) {
        pathsResult[name].should_skip = true
        pathsResult[name].skipped_by = successfulRun
        pathsResult[name].backtrack_count = distanceToHEAD
        core.info(
          `Skip '${name}' because all changes since ${successfulRun.html_url} are in ignored or skipped paths`
        )
        continue
      }

      // Check if backtracking limit has been reached.
      if (
        (pathsFilter[name].backtracking === false && distanceToHEAD === 1) ||
        pathsFilter[name].backtracking === distanceToHEAD
      ) {
        pathsResult[name].should_skip = false
        pathsResult[name].backtrack_count = distanceToHEAD
        core.info(
          `Stop backtracking for '${name}' because the defined limit has been reached`
        )
        continue
      }

      // Ignorable if all changed files match against ignored paths.
      if (isCommitPathsIgnored(changedFiles, pathsFilter[name].paths_ignore)) {
        core.info(
          `Commit ${commit.html_url} is path-ignored for '${name}': All of '${changedFiles}' match against patterns '${pathsFilter[name].paths_ignore}'`
        )
        continue
      }

      // Skippable if none of the changed files matches against paths.
      if (pathsFilter[name].paths.length >= 1) {
        const matches = getCommitPathsMatches(
          changedFiles,
          pathsFilter[name].paths
        )
        if (matches.length === 0) {
          core.info(
            `Commit ${commit.html_url} is path-skipped for '${name}': None of '${changedFiles}' matches against patterns '${pathsFilter[name].paths}'`
          )
          continue
        } else {
          pathsResult[name].matched_files = matches
        }
      }

      // Not ignorable or skippable.
      pathsResult[name].should_skip = false
      pathsResult[name].backtrack_count = distanceToHEAD
      core.info(
        `Stop backtracking for '${name}' at commit ${commit.html_url} because '${changedFiles}' are not skippable against paths '${pathsFilter[name].paths}' or paths_ignore '${pathsFilter[name].paths_ignore}'`
      )
    }

    // Should be never reached in practice; we expect that this loop aborts after 1-3 iterations.
    if (distanceToHEAD++ >= 50) {
      core.warning(
        'Aborted commit-backtracing due to bad performance - Did you push an excessive number of ignored-path commits?'
      )
      break
    }
  } while (
    Object.keys(pathsResult).some(
      path => pathsResult[path].should_skip === 'unknown'
    )
  )

  return {changedFiles: allChangedFiles, pathsResult}
}

function findSuccessfulRun(
  treeHash: string,
  olderRuns: WorkflowRun[]
): WorkflowRun | undefined {
  const matchingRuns = olderRuns.filter(run => run.treeHash === treeHash)
  const successfulRun = matchingRuns.find(run => {
    return run.status === 'completed' && run.conclusion === 'success'
  })
  return successfulRun
}

const globOptions = {
  dot: true // Match dotfiles. Otherwise dotfiles are ignored unless a "." is explicitly defined in the pattern.
}

function isCommitPathsIgnored(
  changedFiles: string[],
  pathsIgnore: string[]
): boolean {
  if (pathsIgnore.length === 0) {
    return false
  }
  const notIgnoredPaths = micromatch.not(changedFiles, pathsIgnore, globOptions)
  return notIgnoredPaths.length === 0
}

function getCommitPathsMatches(
  changedFiles: string[],
  paths: string[]
): string[] {
  const matches = micromatch(changedFiles, paths, globOptions)
  return matches
}

async function fetchCommitDetails(
  sha: string | null,
  context: WRunContext
): Promise<ReposGetCommitResponseData | null> {
  if (!sha) {
    return null
  }
  try {
    const res = await context.octokit.rest.repos.getCommit({
      owner: context.repoOwner,
      repo: context.repoName,
      ref: sha
    })
    return res.data
  } catch (e) {
    if (e instanceof Error || typeof e === 'string') {
      core.warning(e)
    }
    core.warning(`Failed to retrieve commit ${sha}`)
    return null
  }
}

function exitSuccess(args: {
  shouldSkip: boolean
  reason: string
  skippedBy?: WorkflowRun
  changedFiles?: string[][]
  pathsResult?: PathsResult
}): never {
  core.setOutput('should_skip', args.shouldSkip)
  core.setOutput('reason', args.reason)
  core.setOutput('skipped_by', args.skippedBy || {})
  core.setOutput('changed_files', args.changedFiles || [])
  core.setOutput('paths_result', args.pathsResult || {})
  return process.exit(0)
}

function formatCliOptions(options: string[]): string {
  return `${options.map(o => `"${o}"`).join(', ')}`
}
function getConcurrentSkippingInput(name: string): ConcurrentSkippingOption {
  const rawInput = core.getInput(name, {required: true})
  if (rawInput.toLowerCase() === 'false') {
    return 'never' // Backwards-compat
  } else if (rawInput.toLowerCase() === 'true') {
    return 'same_content' // Backwards-compat
  }
  const options = getConcurrentSkippingOptions()
  if (options.includes(rawInput)) {
    return rawInput as ConcurrentSkippingOption
  } else {
    logFatal(`'${name}' must be one of ${formatCliOptions(options)}`)
  }
}

function getBooleanInput(name: string, defaultValue: boolean): boolean {
  const rawInput = core.getInput(name, {required: false})
  if (!rawInput) {
    return defaultValue
  }
  if (defaultValue) {
    return rawInput.toLowerCase() !== 'false'
  } else {
    return rawInput.toLowerCase() === 'true'
  }
}

function getStringArrayInput(name: string): string[] {
  const rawInput = core.getInput(name, {required: false})
  if (!rawInput) {
    return []
  }
  try {
    const array = JSON.parse(rawInput)
    if (!Array.isArray(array)) {
      logFatal(`Input '${rawInput}' is not a JSON-array`)
    }
    for (const e of array) {
      if (typeof e !== 'string') {
        logFatal(`Element '${e}' of input '${rawInput}' is not a string`)
      }
    }
    return array
  } catch (e) {
    if (e instanceof Error || typeof e === 'string') {
      core.error(e)
    }
    logFatal(`Input '${rawInput}' is not a valid JSON`)
  }
}

function getPathsFilterInput(name: string): PathsFilter {
  const rawInput = core.getInput(name, {required: false})
  if (!rawInput) {
    return {}
  }
  try {
    const input = yaml.load(rawInput)
    // Assign default values
    const pathsFilter: PathsFilter = {}
    for (const [key, value] of Object.entries(
      input as Record<string, Partial<PathsFilterEntry>>
    )) {
      pathsFilter[key] = {
        paths: value.paths || [],
        paths_ignore: value.paths_ignore || [],
        backtracking: value.backtracking == null ? true : value.backtracking
      }
    }
    return pathsFilter
  } catch (e) {
    if (e instanceof Error || typeof e === 'string') {
      core.error(e)
    }
    logFatal(`Input '${rawInput}' is invalid`)
  }
}

function logFatal(msg: string): never {
  core.setFailed(msg)
  return process.exit(1)
}

main()
