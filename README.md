# Skip Duplicate Action Runs

`skip-duplicate-action-runs` provides two separate features for [GitHub Actions](https://github.com/features/actions):

- [Detect duplicate Action-runs](#detect-duplicate-action-runs) after branch-merges.
- [Cancel outdated Action-runs](#cancel-outdated-action-runs) after branch-pushes.

Both features help to save time and costs; especially for long-running GitHub Actions.
You can choose either one or both of those features.

## Detect duplicate Action-runs

If you merge lots of feature branches, then you might see lots of _duplicate Action-runs_.
A duplicate Action-run happens if an Action has successfully passed on a feature branch, but the Action is then repeated right after merging the feature branch.
`skip-duplicate-action-runs` helps to prevent such unnecessary runs.

- **Full traceability:** If a duplicate Action-run is detected, then you will see a message like `Skip execution because the exact same files have been successfully checked in https://github.com/fkirc/skip-duplicate-action-runs/actions/runs/263149724`.
- **Respect manual triggers:** If you manually trigger an Action-run with `workflow_dispatch`, then the Action-run will not be skipped.
- **Flexible workflows:** `skip-duplicate-action-runs` does not care whether you use fast-forward-merges, rebase-merges or squash-merges.
  However, if a merge yields a result that is different from the feature branch, then the resulting Action-run will _not_ be skipped.
  This is commonly the case if you merge "outdated branches".
  
## Cancel outdated Action-runs

When you push changes to a branch, then `skip-duplicate-action-runs` will cancel any previous Action-runs that run against outdated commits.
This ensures that GitHub's resources focus on the latest commit, instead of wasting resources for outdated commits.

- **Full traceability:** If an Action-run is cancelled, then you will see a message like `Cancel https://github.com/fkirc/skip-duplicate-action-runs/actions/runs/263149724 because it runs against an outdated commit on branch 'master'.`.
- **Battle-tested:** Most of the implementation is from https://github.com/styfle/cancel-workflow-action.

## Inputs

### `github_token`

**Required** Your access token for GitHub. Should be set to `${{ secrets.GITHUB_TOKEN }}`.

### `cancel_outdated_runs`

Set this to `false` if you want to disable the cancellation feature. Default `true`.

## Outputs

### `should_skip`

Indicates whether the current Action-run is a duplicate Action-run.
If this is `false`, then we should _not_ skip subsequent steps in a workflow.

## Example usage

Typically, you will want to add `skip-duplicate-action-runs` as the first step in a Job:

```yml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: fkirc/skip-duplicate-action-runs@master
        id: skip
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
      - if: ${{ steps.skip.outputs.should_skip == 'false' }}
        run: |
          echo "Running slow tests..."
          echo "Do other stuff..."
```

## How does it work?

`skip-duplicate-action-runs` uses the [Workflow Runs API](https://docs.github.com/en/rest/reference/actions#workflow-runs) to query previous Action-runs.

Firstly, `skip-duplicate-action-runs` will only look at Action-runs that belong to the same workflow as the current Action-run.
After querying such Action-runs, it will compare them with the current Action-run as follows:

- If there exists another Action-runs with the same tree hash, then we have identified a duplicate Action-run.
- If there exists an older in-progress Action-run that matches the current branch but not the current commit, then this Action-run will be cancelled.
