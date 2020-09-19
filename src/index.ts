import * as core from '@actions/core';
import * as github from '@actions/github';
if (!github) {
  throw new Error('Module not found: github');
}
if (!core) {
  throw new Error('Module not found: core');
}

function logFatal(msg: string): never {
  core.setFailed(msg);
  return process.exit(1) as never;
}

async function main() {
  console.log(github.context); // TODO: Remove
  if (github.context.eventName === 'workflow_dispatch') {
    return console.info("Do not skip workflow because it was triggered with workflow_dispatch");
  }

  const headCommit = github.context.payload.head_commit;
  const treeHash: string = headCommit.tree_id;
  if (!treeHash) {
    logFatal("Could not find tree hash of head commit");
  }
  console.log("Found tree hash", treeHash);

  const token = core.getInput('github_token', { required: true });
  if (!token) {
    logFatal("Did not find github_token");
  }
  const octokit = github.getOctokit(token);

  const repo = github.context.payload.repository;
  const repoOwner = repo?.owner?.name;
  const repoName = repo?.name;
  if (!repoOwner) {
    logFatal("Did not find repo owner");
  }
  if (!repoName) {
    logFatal("Did not find repo name");
  }
  /*const { data: current_run } = await octokit.actions.getWorkflowRun({
    owner,
    repo,
    run_id: github.context.runId
  });
  const currentWorkflowId = current_run.workflow_id;
  console.log(`Found current workflow_id: ${currentWorkflowId}`);*/

  const { data } = await octokit.actions.listWorkflowRunsForRepo({
    owner: repoOwner,
    repo: repoName,
    status: "success" as unknown as any,
    per_page: 99
    //workflow_id: currentWorkflowId,
  });
  console.log(`Found ${data.workflow_runs.length} runs total.`, data);
  const successfulRuns = data.workflow_runs.filter((run) => {
    // TODO: Check if belongs to same workflow.
    return run.status === 'completed' && run.conclusion === 'success'
  });
  console.log(`Found ${successfulRuns.length} successful runs.`, successfulRuns);
}

main().catch((e) => {
    console.error(e);
    logFatal(e.message);
  });
