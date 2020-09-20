import * as core from '@actions/core'
import * as github from '@actions/github'
import {ActionsListWorkflowRunsResponseData, ActionsGetWorkflowRunResponseData} from '@octokit/types'

type WorkflowRunStatus = 'queued' | 'in_progress' | 'completed'
type WorkflowRunConclusion = 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out'

interface WorkflowRun {
  treeHash: string;
  status: WorkflowRunStatus;
  conclusion: WorkflowRunConclusion | null;
  html_url: string;
  branch: string | null;
  runId: number;
}

function filterWorkflowRuns(response: ActionsListWorkflowRunsResponseData, currentRun: ActionsGetWorkflowRunResponseData): WorkflowRun[] {
  const rawWorkflowRuns = response.workflow_runs.filter((run) => {
    if (!run.head_commit) {
      core.warning(`Run ${run} does not have a HEAD commit`);
      return false;
    }
    // Only consider older workflow-runs to prevent some nasty race conditions and edge cases.
    return new Date(run.created_at).getTime() < new Date(currentRun.created_at).getTime();
  });
  return rawWorkflowRuns.map((run): WorkflowRun => {
    const treeHash = run.head_commit.tree_id;
    if (!treeHash) {
      logFatal("Received a run without a tree hash");
    }
    return {
      treeHash,
      status: run.status as WorkflowRunStatus,
      conclusion: run.conclusion as WorkflowRunConclusion ?? null,
      html_url: run.html_url,
      branch: run.head_branch ?? null,
      runId: run.id,
    }
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
  const currentWorkflowId = current_run.workflow_id;
  if (!currentWorkflowId) {
    logFatal("Did not find the current workflow id");
  }
  const currentTreeHash = current_run.head_commit.tree_id;
  if (!currentTreeHash) {
    logFatal(`Did not find the current tree hash for current run ${current_run}`);
  }
  const currentBranch: string | null = current_run.head_branch ?? null;

  const { data } = await octokit.actions.listWorkflowRuns({
    owner: repoOwner,
    repo: repoName,
    workflow_id: currentWorkflowId,
    per_page: 100,
  });
  const workflowRuns = filterWorkflowRuns(data, current_run);

  const cancelVictims = workflowRuns.filter((run) => {
    if (run.treeHash === currentTreeHash) {
      return false;
    }
    return run.branch === currentBranch;
  });
  await cancelOutdatedRuns({
    cancelVictims,
    octokit,
    repoOwner,
    repoName,
  });

  const duplicateRuns = workflowRuns.filter((run) => run.treeHash === currentTreeHash);
  detectDuplicateRunsAndExit(duplicateRuns);
}

async function cancelOutdatedRuns(args: {
  cancelVictims: WorkflowRun[],
  octokit: any,
  repoOwner: string,
  repoName: string,
}) {
  const cancellationEnabled = getBooleanInput('cancellation_enabled', true);
  if (!cancellationEnabled) {
    return core.info(`Skip cancellation because 'cancellation_enabled' is set to false`);
  }
  if (!args.cancelVictims.length) {
    return core.info(`Skip cancellation because we did not find any suitable cancellation targets`);
  }
  for (const victim of args.cancelVictims) {
    try {
      const res = await args.octokit.actions.cancelWorkflowRun({
        owner: args.repoOwner,
        repo: args.repoName,
        run_id: victim.runId,
      });
      core.info(`Cancelled run ${victim.html_url} with response code ${res.status}`);
    } catch (e) {
      core.warning(e);
      core.warning(`Failed to cancel run ${victim.html_url}`);
    }
  }
}

function detectDuplicateRunsAndExit(duplicateRuns: WorkflowRun[]): never {
  if (github.context.eventName === 'workflow_dispatch') {
    core.info("Do not skip execution because the workflow was triggered with workflow_dispatch.");
    exitSuccess({ shouldSkip: false});
  }
  const successfulDuplicate = duplicateRuns.find((run) => {
    return run.status === 'completed' && run.conclusion === 'success';
  });
  if (successfulDuplicate) {
    core.info(`Skip execution because the exact same files have been successfully checked in ${successfulDuplicate.html_url}`);
    exitSuccess({ shouldSkip: true});
  }
  const concurrentDuplicate = duplicateRuns.find((run) => {
    return run.status === 'queued' || run.status === 'in_progress';
  });
  if (concurrentDuplicate) {
    core.info(`Skip execution because the exact same files are concurrently checked in ${concurrentDuplicate.html_url}`);
    exitSuccess({ shouldSkip: true});
  }
  const failedDuplicate = duplicateRuns.find((run) => {
    return run.status === 'completed' && run.conclusion === 'failure';
  });
  if (failedDuplicate) {
    logFatal(`Trigger a failure because ${failedDuplicate.html_url} has already failed with the exact same files. You can use 'workflow_dispatch' to manually enforce a re-run.`);
  }
  core.info("Do not skip execution because we did not find a duplicate run.");
  exitSuccess({ shouldSkip: false});
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

function exitSuccess(args: { shouldSkip: boolean }): never {
  core.setOutput("should_skip", args.shouldSkip);
  return process.exit(0) as never;
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
