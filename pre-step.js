const core = require('@actions/core');
const github = require('@actions/github');

try {
  const time = (new Date()).toTimeString();
  core.setOutput("time", time);
  // Get the JSON webhook payload for the event that triggered the workflow
  const context = JSON.stringify(github.context, undefined, 2)
  console.log(`The event context: ${context}`);
  const headCommit = github.context.payload.head_commit;
  const treeHash = headCommit.tree_id;
  const commitUrl = headCommit.url;
  console.info(`Tree hash: ${treeHash}`);
  console.info(`Commit URL: ${commitUrl}`);
} catch (error) {
  console.error(error);
  core.setFailed(error);
}
