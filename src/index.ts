import * as core from '@actions/core'
import * as github from '@actions/github'
import {
  ActionsGetWorkflowRunResponseData,
  ActionsListWorkflowRunsResponseData,
  ReposGetCommitResponseData
} from '@octokit/types'
const micromatch = require('micromatch');

type WorkflowRunStatus = 'queued' | 'in_progress' | 'completed'
type WorkflowRunConclusion = 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out'

interface WorkflowRun {
  treeHash: string;
  commitHash: string;
  status: WorkflowRunStatus;
  conclusion: WorkflowRunConclusion | null;
  html_url: string;
  branch: string | null;
  runId: number;
  workflowId: number;
  createdAt: string;
}

interface WRunContext {
  repoOwner: string;
  repoName: string;
  currentRun: WorkflowRun;
  otherRuns: WorkflowRun[];
  octokit: any;
  pathsIgnore: string[];
  paths: string[];
}

function parseWorkflowRun(run: ActionsGetWorkflowRunResponseData): WorkflowRun {
  const treeHash = run.head_commit?.tree_id;
  if (!treeHash) {
    logFatal(`Could not find the tree hash of run ${run}`);
  }
  const workflowId = run.workflow_id;
  if (!workflowId) {
    logFatal(`Could not find the workflow id of run ${run}`);
  }
  return {
    treeHash,
    commitHash: run.head_sha,
    status: run.status as WorkflowRunStatus,
    conclusion: run.conclusion as WorkflowRunConclusion ?? null,
    html_url: run.html_url,
    branch: run.head_branch ?? null,
    runId: run.id,
    workflowId,
    createdAt: run.created_at,
  }
}

function filterWorkflowRuns(response: ActionsListWorkflowRunsResponseData, currentRun: WorkflowRun): WorkflowRun[] {
  const rawWorkflowRuns = response.workflow_runs.filter((run) => {
    // Only consider older workflow-runs to prevent some nasty race conditions and edge cases.
    return new Date(run.created_at).getTime() < new Date(currentRun.createdAt).getTime();
  });
  return rawWorkflowRuns.map((run): WorkflowRun => {
    return parseWorkflowRun(run);
  });
}

async function main() {
  const token = core.getInput('github_token', { required: true });
  if (!token) {
    logFatal("Did not find github_token");
  }
  const repo = github.context.repo;
  const repoOwner = repo?.owner;
  if (!repoOwner) {
    logFatal("Did not find the repo owner");
  }
  const repoName = repo?.repo;
  if (!repoName) {
    logFatal("Did not find the repo name");
  }
  const runId = github.context.runId;
  if (!runId) {
    logFatal("Did not find runId");
  }

  const octokit = github.getOctokit(token);
  const { data: current_run } = await octokit.actions.getWorkflowRun({
    owner: repoOwner,
    repo: repoName,
    run_id: runId,
  });
  const currentRun = parseWorkflowRun(current_run);

  const { data } = await octokit.actions.listWorkflowRuns({
    owner: repoOwner,
    repo: repoName,
    workflow_id: currentRun.workflowId,
    per_page: 100,
  });
  const otherRuns = filterWorkflowRuns(data, currentRun);
  const context: WRunContext = {
    repoOwner,
    repoName,
    currentRun,
    otherRuns,
    octokit,
    pathsIgnore: getStringArrayInput("paths_ignore"),
    paths: getStringArrayInput("paths"),
  };

  const cancelOthers = getBooleanInput('cancel_others', true);
  if (cancelOthers) {
    await cancelOutdatedRuns(context);
  }
  detectDuplicateRuns(context);
  if (context.paths.length >= 1 || context.pathsIgnore.length >= 1) {
    await backtracePathSkipping(context);
  }
  core.info("Do not skip execution because we did not find a transferable run");
  exitSuccess({ shouldSkip: false });
}

async function cancelOutdatedRuns(context: WRunContext) {
  const currentRun = context.currentRun;
  const cancelVictims = context.otherRuns.filter((run) => {
    if (run.status === 'completed') {
      return false;
    }
    return run.treeHash !== currentRun.treeHash && run.branch === currentRun.branch;
  });
  if (!cancelVictims.length) {
    return core.info(`Did not find other workflow-runs to be cancelled`);
  }
  for (const victim of cancelVictims) {
    await cancelWorkflowRun(victim, context)
  }
}

async function cancelWorkflowRun(run: WorkflowRun, context: WRunContext) {
  try {
    const res = await context.octokit.actions.cancelWorkflowRun({
      owner: context.repoOwner,
      repo: context.repoName,
      run_id: run.runId,
    });
    core.info(`Cancelled ${run.html_url} with response code ${res.status}`);
  } catch (e) {
    core.warning(e);
    core.warning(`Failed to cancel ${run.html_url}`);
  }
}

function detectDuplicateRuns(context: WRunContext) {
  const duplicateRuns = context.otherRuns.filter((run) => run.treeHash === context.currentRun.treeHash);

  if (github.context.eventName === 'workflow_dispatch') {
    core.info("Do not skip execution because the workflow was triggered with workflow_dispatch");
    exitSuccess({ shouldSkip: false });
  }
  const successfulDuplicate = duplicateRuns.find((run) => {
    return run.status === 'completed' && run.conclusion === 'success';
  });
  if (successfulDuplicate) {
    core.info(`Skip execution because the exact same files have been successfully checked in ${successfulDuplicate.html_url}`);
    exitSuccess({ shouldSkip: true });
  }
  const concurrentDuplicate = duplicateRuns.find((run) => {
    return run.status !== 'completed';
  });
  if (concurrentDuplicate) {
    core.info(`Skip execution because the exact same files are concurrently checked in ${concurrentDuplicate.html_url}`);
    exitSuccess({ shouldSkip: true });
  }
  const failedDuplicate = duplicateRuns.find((run) => {
    return run.status === 'completed' && run.conclusion === 'failure';
  });
  if (failedDuplicate) {
    logFatal(`Trigger a failure because ${failedDuplicate.html_url} has already failed with the exact same files. You can use 'workflow_dispatch' to manually enforce a re-run.`);
  }
}

async function backtracePathSkipping(context: WRunContext) {
  let commit: ReposGetCommitResponseData | null;
  let iterSha: string | null = context.currentRun.commitHash;
  let distanceToHEAD = 0;
  do {
    commit = await fetchCommitDetails(iterSha, context);
    if (!commit) {
      return;
    }
    iterSha = commit.parents?.length ? commit.parents[0]?.sha : null;

    exitIfSuccessfulRunExists(commit, context);

    if (distanceToHEAD++ >= 50) {
      // Should be never reached in practice; we expect that this loop aborts after 1-3 iterations.
      core.warning(`Aborted commit-backtracing due to bad performance - Did you push an excessive number of ignored-path-commits?`);
      return;
    }
  } while (isCommitSkippable(commit, context));
}

function exitIfSuccessfulRunExists(commit: ReposGetCommitResponseData, context: WRunContext) {
  const treeHash = commit.commit.tree.sha;
  const matchingRuns = context.otherRuns.filter((run) => run.treeHash === treeHash);
  const successfulRun = matchingRuns.find((run) => {
    return run.status === 'completed' && run.conclusion === 'success';
  });
  if (successfulRun) {
    core.info(`Skip execution because all changes since ${successfulRun.html_url} are in ignored or skipped paths`);
    exitSuccess({ shouldSkip: true });
  }
}

function isCommitSkippable(commit: ReposGetCommitResponseData, context: WRunContext): boolean {
  const changedFiles = commit.files.map((f) => f.filename);
  if (isCommitPathIgnored(commit, context)) {
    core.info(`Commit ${commit.html_url} is path-ignored: All of '${changedFiles}' match against patterns '${context.pathsIgnore}'`);
    return true;
  }
  if (isCommitPathSkipped(commit, context)) {
    core.info(`Commit ${commit.html_url} is path-skipped: None of '${changedFiles}' matches against patterns '${context.paths}'`);
    return true;
  }
  return false;
}

function isCommitPathIgnored(commit: ReposGetCommitResponseData, context: WRunContext): boolean {
  if (!context.pathsIgnore.length) {
    return false;
  }
  // Skip if all changed files match against pathsIgnore.
  const changedFiles = commit.files.map((f) => f.filename);
  core.info(context.pathsIgnore.toString());
  const notIgnoredPaths = micromatch.not(changedFiles, context.pathsIgnore);
  core.info(notIgnoredPaths);
  return notIgnoredPaths.length === 0;
}

function isCommitPathSkipped(commit: ReposGetCommitResponseData, context: WRunContext): boolean {
  if (!context.paths.length) {
    return false;
  }
  // Skip if none of the changed files matches against context.paths.
  const changedFiles = commit.files.map((f) => f.filename);
  const matchExists = micromatch.some(changedFiles, context.paths);
  return !matchExists;
}

async function fetchCommitDetails(sha: string | null, context: WRunContext): Promise<ReposGetCommitResponseData | null> {
  if (!sha) {
    return null;
  }
  try {
    const res = await context.octokit.repos.getCommit({
      owner: context.repoOwner,
      repo: context.repoName,
      ref: sha,
    });
    //core.info(`Fetched ${res} with response code ${res.status}`);
    return res.data;
  } catch (e) {
    core.warning(e);
    core.warning(`Failed to retrieve commit ${sha}`);
    return null;
  }
}

function exitSuccess(args: { shouldSkip: boolean }): never {
  core.setOutput("should_skip", args.shouldSkip);
  return process.exit(0) as never;
}

function getBooleanInput(name: string, defaultValue: boolean): boolean {
  const rawInput = core.getInput(name, { required: false });
  if (!rawInput) {
    return defaultValue;
  }
  if (defaultValue) {
    return rawInput.toLowerCase() !== 'false';
  } else {
    return rawInput.toLowerCase() !== 'true';
  }
}

function getStringArrayInput(name: string): string[] {
  const rawInput = core.getInput(name, { required: false });
  if (!rawInput) {
    return [];
  }
  try {
    const array = JSON.parse(rawInput);
    if (!Array.isArray(array)) {
      logFatal(`Input '${rawInput}' is not a JSON-array`);
    }
    array.forEach((e) => {
      if (typeof e !== "string") {
        logFatal(`Element '${e}' of input '${rawInput}' is not a string`);
      }
    });
    return array;
  } catch (e) {
    core.error(e);
    logFatal(`Input '${rawInput}' is not a valid JSON`);
  }
}

function logFatal(msg: string): never {
  core.setFailed(msg);
  return process.exit(1) as never;
}

main().catch((e) => {
  core.error(e);
  logFatal(e.message);
});
