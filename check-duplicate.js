const artifact = require('@actions/artifact');
const artifactClient = artifact.create()

async function run() {
  const path = '.';
  const artifactName = 'my-artifact';
  const options = {
    createArtifactFolder: false,
  };
  const downloadResponse = await artifactClient.downloadArtifact(artifactName, path, options);
  console.info(JSON.stringify(downloadResponse));
}

run().catch((error) => {
  console.error(error);
  core.setFailed(error);
});
