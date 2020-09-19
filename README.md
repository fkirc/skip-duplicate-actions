# Cancel Workflow Action

This is a GitHub Action that will cancel any previous runs that are not `completed` for a given workflow.

This includes runs with a [status](https://docs.github.com/en/rest/reference/checks#check-runs) of `queued` or `in_progress`.

## How does it work?

When you `git push`, this GitHub Action will capture the current Branch and SHA. It will query GitHub's API to find previous workflow runs that match the Branch but do not match the SHA. These in-progress runs will be cancelled leaving only the latest run.

Read more about the [Workflow Runs API](https://docs.github.com/en/rest/reference/actions#workflow-runs).

## Usage

Typically, you will want to add this action as the first step in a workflow so it can cancel itself on the next push.

```yml
jobs:
  my_job:
    runs-on: ubuntu-latest
    steps:
      - uses: fkirc/skip-duplicate-action-runs@master
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
```
