# Skip Duplicate Actions

`skip-duplicate-actions` provides two separate features for [GitHub Actions](https://github.com/features/actions):

- [Skip duplicate workflow-runs](#skip-duplicate-workflow-runs) after merges or pull requests.
- [Cancel outdated workflow-runs](#cancel-outdated-workflow-runs) after branch-pushes.

Both features help to save time and costs; especially for long-running workflows.
You can choose either one or both of those features.

## Skip duplicate workflow-runs

If you work with feature branches, then you might see lots of _duplicate workflow-runs_.
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

Typically, workflows should only run for the most recent commit.
Therefore, when you push changes to a branch, `skip-duplicate-actions` will cancel any previous workflow-runs that run against outdated commits.

- **Full traceability:** If a workflow-run is cancelled, then you will see a message like `Cancelled https://github.com/fkirc/skip-duplicate-actions/actions/runs/263149724 because it runs against an outdated commit on branch 'master'`.
- **Guaranteed execution:** Despite the underlying complexity, the cancellation algorithm guarantees that a complete check-set will finish no matter what.

## Inputs

### `github_token`

**Required** Your access token for GitHub.

### `cancel_others`

If true, then workflow-runs from outdated commits will be cancelled. Default `true`.

## Outputs

### `should_skip`

true if the current run is a duplicate workflow-run. This should be evaluated for either individual steps or entire jobs.

## Usage examples

You can use `skip-duplicate-actions` to either skip individual steps or entire jobs.
Which one is easier depends on your workflow.

### Option 1: Skip entire jobs

To skip entire jobs, you will need a `pre_job` that acts as a pre-condition for your `main_job`.
Although this example looks like a lot of code, there are only two additional lines in your project-specific `main_job` (the `needs`-clause and the `if`-clause):

```yml
jobs:
  pre_job:
    runs-on: ubuntu-latest
    # Map a step output to a job output
    outputs:
      should_skip: ${{ steps.skip_check.outputs.should_skip }}
    steps:
      - id: skip_check
        uses: fkirc/skip-duplicate-actions@master
        with:
          github_token: ${{ github.token }}

  main_job:
    needs: pre_job
    if: ${{ needs.pre_job.outputs.should_skip == 'false' }}
    runs-on: ubuntu-latest
    steps:
      - run: echo "Running slow tests..." && sleep 30
```

### Option 2: Skip individual steps

If you do not want an additional `pre_job`, then you can use `skip-duplicate-actions` to skip additional steps.
This example demonstrates how to skip an individual step with an `if`-clause and an `id`:

```yml
jobs:
  skip_individual_steps_job:
    runs-on: ubuntu-latest
    steps:
      - id: skip_check
        uses: fkirc/skip-duplicate-actions@master
        with:
          github_token: ${{ github.token }}
      - if: ${{ steps.skip_check.outputs.should_skip == 'false' }}
        run: |
          echo "Running slow tests..." && sleep 30
          echo "Do other stuff..."
```

## How does it work?

`skip-duplicate-actions` uses the [Workflow Runs API](https://docs.github.com/en/rest/reference/actions#workflow-runs) to query workflow-runs.

Firstly, `skip-duplicate-actions` will only look at workflow-runs that belong to the same workflow as the current workflow-run.
Secondly, `skip-duplicate-actions` will only look at _older_ workflow-runs in order to guard against race conditions and edge cases.
After querying such workflow-runs, it will compare them with the current workflow-run as follows:

- If there exists a workflow-runs with the same tree hash, then we have identified a duplicate workflow-run.
- If there exists an in-progress workflow-run that matches the current branch but not the current tree hash, then this workflow-run will be cancelled.
