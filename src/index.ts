import * as core from '@actions/core'
import * as github from '@actions/github'
import {ActionsListWorkflowRunsResponseData, ActionsGetWorkflowRunResponseData} from '@octokit/types'

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
  };

  await cancelOutdatedRuns(context);
  detectDuplicateRuns(context);
  await detectPathIgnore(context);

  core.info("Do not skip execution because we did not find a duplicate run");
  exitSuccess({ shouldSkip: false });
}

async function cancelOutdatedRuns(context: WRunContext) {
  const cancelOthers = getBooleanInput('cancel_others', true);
  if (!cancelOthers) {
    return core.info(`Skip cancellation because 'cancel_others' is set to false`);
  }
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

async function detectPathIgnore(context: WRunContext) {
  await fetchCommitDetails(context.currentRun.commitHash, context);
}

async function fetchCommitDetails(sha: string, context: WRunContext) {
  try {
    console.log(Object.keys(context.octokit.keys)); // TODO: Remove
    const res = await context.octokit.commits.getCommit({
      owner: context.repoOwner,
      repo: context.repoName,
      ref: sha,
    });
    core.info(`Fetched ${res} with response code ${res.status}`); // TODO: Remove
  } catch (e) {
    core.warning(e);
    core.warning(`Failed to retrieve commit ${sha}`);
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

function logFatal(msg: string): never {
  core.setFailed(msg);
  return process.exit(1) as never;
}

main().catch((e) => {
  core.error(e);
  //console.error(e);
  logFatal(e.message);
});
