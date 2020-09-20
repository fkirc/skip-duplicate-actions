# Skip Duplicate Action Runs

If you use [GitHub Actions](https://github.com/features/actions) with feature branches, then you might see lots of _duplicate Action-runs_.
A duplicate Action-run happens if an Action has successfully passed on a feature branch, but the Action is then repeated right after merging the feature branch.
`skip-duplicate-action-runs` helps to prevent such unnecessary runs; saving both time and costs.

## Features

- **Full traceability:** If an Action-run is skipped, then you will see a message like `Skip execution because the exact same files have been successfully checked in https://github.com/fkirc/skip-duplicate-action-runs/actions/runs/263149724`.
  To see those successful checks, you only need to follow the link.
- **Respect manual triggers:** If you manually trigger an Action-run with `workflow_dispatch`, then the Action-run will be never skipped.
- **Flexible workflows:** `skip-duplicate-action-runs` does not care whether you use fast-forward-merges, rebase-merges or squash-merges.
  However, if a merge yields a result that is different from the feature branch, then the resulting Action-run will _not_ be skipped.
  This is commonly the case if you merge "outdated branches".
  
## Inputs

### `github_token`

**Required** Your access token for GitHub. Should be set to `${{ secrets.GITHUB_TOKEN }}`.

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

`skip-duplicate-action-runs` uses the [Workflow Runs API](https://docs.github.com/en/rest/reference/actions#workflow-runs) to query previous Action-runs and their tree hashes.
If we find two Action-runs with the same tree hashes and the same workflow files, then we have identified a duplicate Action-run.
