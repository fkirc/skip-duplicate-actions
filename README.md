# Skip Duplicate Actions

`skip-duplicate-actions` provides two separate features for [GitHub Actions](https://github.com/features/actions):

- [Detect duplicate workflow-runs](#detect-duplicate-workflow-runs) after merges or pull requests.
- [Cancel outdated workflow-runs](#cancel-outdated-workflow-runs) after branch-pushes.

Both features help to save time and costs; especially for long-running workflows.
You can choose either one or both of those features.

## Detect duplicate workflow-runs

If you merge lots of feature branches, then you might see lots of _duplicate workflow-runs_.
For example, duplicate workflow-runs can happen if a workflow runs on a feature branch, but then the workflow is repeated right after merging the feature branch.
`skip-duplicate-actions` helps to prevent such unnecessary runs.

- **Traceable success propagation:** After clean merges, you will see a message like `Skip execution because the exact same files have been successfully checked in https://github.com/fkirc/skip-duplicate-actions/actions/runs/263149724`.
- **Traceable failure propagation:** If failure is inevitable, then you will see a message like `Trigger a failure because https://github.com/fkirc/skip-duplicate-actions/actions/runs/263945012 has already failed with the exact same files. You can use 'workflow_dispatch' to manually enforce a re-run`.
- **Skip concurrent workflow-runs:** If the same workflow is unnecessarily triggered twice, then one of the workflow-runs will be skipped.
  For example, this can happen if a workflow has both `push` and `pull_request` triggers.
- **Respect manual triggers:** If you manually trigger a workflow with `workflow_dispatch`, then the workflow-run will not be skipped.
- **Flexible Git usage:** `skip-duplicate-actions` does not care whether you use fast-forward-merges, rebase-merges or squash-merges.
  However, if a merge yields a result that is different from the source branch, then the resulting workflow-run will _not_ be skipped.
  This is commonly the case if you merge "outdated branches".
  
## Cancel outdated workflow-runs

When you push changes to a branch, then `skip-duplicate-actions` will cancel any previous workflow-runs that run against outdated commits.

- **Full traceability:** If a workflow-run is cancelled, then you will see a message like `Cancelled https://github.com/fkirc/skip-duplicate-actions/actions/runs/263149724 because it runs against an outdated commit on branch 'master'`.
- **Battle-tested:** Most of the implementation is from https://github.com/styfle/cancel-workflow-action.
- **Guaranteed execution:** Despite the underlying complexity, the cancellation algorithm guarantees that a complete check-set will finish no matter what.

## Inputs

### `github_token`

**Required** Your access token for GitHub.

### `cancellation_enabled`

Set this to `false` if you want to disable the cancellation feature. Default `true`.

## Outputs

### `should_skip`

Indicates whether the current workflow-run is a duplicate workflow-run.

## Example usage

Typically, you will want to add `skip-duplicate-actions` as the first step in a Job:

```yml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: fkirc/skip-duplicate-actions@master
        id: skip
        with:
          github_token: ${{ github.token }}
      - if: ${{ steps.skip.outputs.should_skip == 'false' }}
        run: |
          echo "Running slow tests..."
          echo "Do other stuff..."
```

## How does it work?

`skip-duplicate-actions` uses the [Workflow Runs API](https://docs.github.com/en/rest/reference/actions#workflow-runs) to query workflow-runs.

Firstly, `skip-duplicate-actions` will only look at workflow-runs that belong to the same workflow as the current workflow-run.
Secondly, `skip-duplicate-actions` will only look at _older_ workflow-runs in order to guard against race conditions and edge cases.
After querying such workflow-runs, it will compare them with the current workflow-run as follows:

- If there exists a workflow-runs with the same tree hash, then we have identified a duplicate workflow-run.
- If there exists an in-progress workflow-run that matches the current branch but not the current tree hash, then this workflow-run will be cancelled.
