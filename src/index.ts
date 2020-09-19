import * as core from '@actions/core';
import * as github from '@actions/github';
if (!github) {
  throw new Error('Module not found: github');
}
if (!core) {
  throw new Error('Module not found: core');
}

export function logFatal(msg: string): never {
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

  const { owner, repo } = github.context.payload;
  const { data: current_run } = await octokit.actions.getWorkflowRun({
    owner,
    repo,
    run_id: Number(process.env.GITHUB_RUN_ID)
  });
  const currentWorkflowId = current_run.workflow_id;
  console.log(`Found current workflow_id: ${currentWorkflowId}`);

  const { data } = await octokit.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: currentWorkflowId,
  });
  console.log(`Found ${data.total_count} runs total.`, data);
  const successfulWorkflows = data.workflow_runs.filter(
    run => run.status === 'completed' && run.conclusion === 'success'
  );
  console.log(`Found ${successfulWorkflows.length} successful runs.`, successfulWorkflows);
}

main().catch((e) => {
    console.error(e);
    core.setFailed(e.message)
  });
