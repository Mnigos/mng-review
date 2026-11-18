# ADR 0006: The workflow runs on `pull_request_target` in shadow mode

**Status:** Proposed
**Date:** 2026-11-18

## Context

Stage 3 runs the review in GitHub Actions. The review needs the endpoint URL and key as secrets. A `pull_request` run from a fork gets no secrets, and a run from a branch of the same repository gets them but uses the workflow file from the pull request's head, so the pull request can change the workflow that holds the secrets. `pull_request_target` runs the workflow file from the base branch with secrets, which is safe only as long as nothing from the pull request runs. Before the review posts anything (stage 4), its findings and cost need to be watched on real pull requests without disturbing them.

## Decision

- The caller triggers the reusable workflow on `pull_request_target` (`opened`, `synchronize`, `reopened`, `ready_for_review`) with `permissions: contents: read`, and owns the concurrency group, one per pull request with `cancel-in-progress: true`.
- Only a pull request from the caller's own repository starts the job. The job checks out the caller's base commit only, with full history and without persisted credentials, and fetches the head commit's objects with the job token passed in the environment. The head is never checked out. Nothing from the caller's repository is installed, built or run; the engine is checked out from this repository at the called workflow's own commit (`job.workflow_sha`) into a separate directory and installed with `--production --ignore-scripts`. Bun starts in the engine's directory with `--no-env-file`, so no `bunfig.toml`, `.env` or `tsconfig.json` of the caller's repository is read, and git is pointed at the caller's checkout through `MNG_REVIEW_REPO_DIR`. Where `job.workflow_sha` is not available (GitHub Enterprise Server), the job fails instead of checking out the caller's code.
- `.mng/` is read from the base commit. A pull request cannot change the rules it is judged by.
- Fork pull requests are skipped twice: the job's `if` keeps them from the secrets and the tailnet, and the entry skips them before it reads the rules.
- The job log gets one line per run; git output and endpoint messages in it lose control characters and workflow-command markers, so they cannot act as commands.
- Title, body and labels reach the models only as fenced data. Every text in the job summary that comes from a model or the repository is escaped, and URLs become code, so it cannot add links, images or HTML.
- Shadow mode: the result goes to the job summary only. No comment, review, check run or status is created. The job exits 0 whatever the findings and when the endpoint is offline (`GET /models` unreachable, timed out, 401, 403, 429 or 5xx; also when the URL is not set); 2 when `.mng/` at the base commit or the event is invalid, naming the file or key; 1 when git cannot read the change.
- The endpoint URL and key are registered with `::add-mask::` before anything else and never printed.
- An optional ephemeral tailnet node, with tags the caller gives, reaches an endpoint that is not on the internet. It joins with `--accept-routes=false --shields-up`. The tailnet's access rules decide what that node can reach; the documentation asks for a tag that reaches only the endpoint's host and port and an OAuth client limited to that tag.

## Consequences

- Same-repository pull requests get a review without the pull request being able to change the workflow, the rules or the code that runs.
- A pull request that edits `.mng/` is judged by the old rules; its new rules apply after it merges.
- A compromised job could read the endpoint key and, with Tailscale, reach what the node's tags allow. The job runs no pull request code, its token is read-only, and the tag should allow the endpoint only.
- Fork contributors get no review until a later stage adds an opt-in for them.
- Rejected: `pull_request` (fork runs have no secrets, same-repository runs use the head's workflow file); checking out the head (the engine would read files from a tree the pull request controls, and a later step could run them); `workflow_run` after a `pull_request` run (two workflows and an artifact hand-off for the same guarantees).

## Related

- `docs/spec.md`: Running it, CI in shadow mode
- `.github/workflows/review.yml`
