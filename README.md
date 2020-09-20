# Skip Duplicate Action Runs

If you are using GitHub Actions with feature branches, then you might see lots of _duplicate Action-runs_.
A duplicate Action-run happens if an Action has successfully passed on a feature branch, but the Action is then repeated right after merging the feature branch.
`skip-duplicate-action-runs` helps to prevent such unnecessary runs; saving both time and costs.

## Features

- **Full traceability:** If an Action-run is skipped, then you will see a message like `Skip execution because the exact same files have been successfully checked in https://github.com/fkirc/skip-duplicate-action-runs/actions/runs/263149724`.
  To see those successful checks, you only need to follow the link.
- **Respect manual triggers:** If you manually trigger an Action-run with `workflow_dispatch`, then the Action-run will be never skipped.
- **Flexible workflows:** `skip-duplicate-action-runs` does not care whether you use fast-forward-merges, rebase-merges or squash-merges.
  However, if a merge yields a result that is different from the feature branch, then the resulting Action-run will _not_ be skipped.
  This is commonly the case if you merge "outdated branches".

## Usage

Typically, you will want to add `skip-duplicate-action-runs` as the first step in a workflow:

```yml
jobs:
  my_job:
    runs-on: ubuntu-latest
    steps:
      - uses: fkirc/skip-duplicate-action-runs@master
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

## How does it work?

`skip-duplicate-action-runs` uses the [Workflow Runs API](https://docs.github.com/en/rest/reference/actions#workflow-runs) to query previous Action-runs and their tree hashes.
If we find two Action-runs with the same tree hashes and the same workflow files, then we have identified a duplicate Action-run.

