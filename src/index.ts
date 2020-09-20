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
}

async function main() {
  const currentTreeHash: string = github.context?.payload?.head_commit?.tree_id;
  if (!currentTreeHash) {
    logFatal(`Did not find the current tree has in context ${github.context}`);
  }
  const repo = github.context.payload.repository;
  const repoOwner = repo?.owner?.name;
  const repoName = repo?.name;
  if (!repoOwner) {
    logFatal("Did not find the repo owner");
  }
  if (!repoName) {
    logFatal("Did not find the repo name");
  }
  const token = core.getInput('github_token', { required: true });
  if (!token) {
    logFatal("Did not find github_token");
  }

  const octokit = github.getOctokit(token);
  const { data: current_run } = await octokit.actions.getWorkflowRun({
    owner: repoOwner,
    repo: repoName,
    run_id: github.context.runId
  });
  const currentWorkflowId = current_run.workflow_id;
  if (!currentWorkflowId) {
    logFatal("Did not find the current workflow id");
  }

  const { data } = await octokit.actions.listWorkflowRuns({
    owner: repoOwner,
    repo: repoName,
    workflow_id: currentWorkflowId,
    per_page: 100,
  });
  const workflowRuns = filterWorkflowRuns(data, current_run);

  const duplicateRuns = workflowRuns.filter((run) => run.treeHash === currentTreeHash);
  detectDuplicateWorkflowsAndExit(duplicateRuns);
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
      conclusion: run.conclusion as WorkflowRunConclusion | null,
      html_url: run.html_url
    }
  });
}

function detectDuplicateWorkflowsAndExit(duplicateRuns: WorkflowRun[]): never {
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
    logFatal(`Trigger a failure because ${failedDuplicate.html_url} has failed with the exact same files. You can use 'workflow_dispatch' to manually enforce a re-run.`);
  }
  core.info("Do not skip execution because we did not find a duplicate run.");
  exitSuccess({ shouldSkip: false});
}

main().catch((e) => {
  core.error(e);
  console.error(e);
  logFatal(e.message);
});

function exitSuccess(args: { shouldSkip: boolean }): never {
  core.setOutput("should_skip", args.shouldSkip);
  return process.exit(0) as never;
}

function logFatal(msg: string): never {
  core.setFailed(msg);
  return process.exit(1) as never;
}
