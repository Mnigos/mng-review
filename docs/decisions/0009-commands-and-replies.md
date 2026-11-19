# ADR 0009: Commands need an admin and a secretless check; replies are polled, never triggered

**Status:** Proposed
**Date:** 2026-11-19

## Context

Stage 4 ends with two ways for people to talk to the bot: a `/mng-review` command in a pull request comment starts a review, and a reply in one of the bot's threads ("fixed", "intentional because…") gets an answer. Both act on text other people write, and both can spend the endpoint's quota. `issue_comment` workflows run from the default branch. A reply in a review thread fires `pull_request_review_comment`, which, like `pull_request`, runs the caller's workflow file from the pull request's merge ref: a pull request can change that file. The job token's identity is shared with every other workflow of the repository (ADR 0007), and a writer can read the repository's secrets through any `push` workflow of their own branch.

## Decision

- Commands run through `review-command.yml`, which a caller triggers on `issue_comment` (`created`). Its first job has no secret, no tailnet and read access only: it parses the command (alone on its line, outside code blocks, the first one wins: `/mng-review`, `/mng-review deep`, `/mng-review <agent>`), reads the comment again and refuses one that changed or is gone, refuses a comment by anything but a `User` or one an app posted, and checks the commenter's role on the repository: `admin`, or a login listed in `commands.allow` (read from the default branch's `.mng/`) that still has `maintain` or `write`. Any GitHub error denies. It refuses an unknown agent name, a closed pull request and one from a fork, and a pull request that has used `commands.max_runs` manual runs. Only then does the second job get the secrets and the tailnet; it reviews the commits the first job checked and publishes like `review-publish.yml`.
- A command run is a manual trigger: exempt from `limits.max_runs_per_pr`, counted in the summary's `manualRuns`. `deep` sets the depth directly (a request on the pull request info, not a label, so it cannot meet `when.labels` or `skip.labels`). `<agent>` runs only that declared agent, on every reviewable file when its `when` rules do not select it; such a run never counts as a full review: it keeps the last finished head and finished flag. Drafts and `skip.labels` still skip a command run, as they skip a push, unless a `labels.always_review` label is set.
- Replies are never handled from `pull_request_review_comment`. The bot answers them in every publish and command run and in a scheduled converse workflow on the default branch, so no workflow a pull request can change sits next to the secrets, and no `workflow_run` hand-off has to be trusted. A reply waits up to one schedule interval.
- Only replies by a `User` with write access count. The bot never answers its own comments or any comment that ends with one of its markers, never closes a thread from model output alone, and decides closures in the engine: "fixed" goes through the validator's re-check over the change since the thread's commit, without the reply text, and only after a commit since; "intentional" is accepted only at or below `disputes.accept_intentional_up_to` (the severity in the bot's own unedited marker), never for `critical` or a file under `risk_paths`, and only with evidence the engine checks: an existing path and line at the head or the merge base, not added by the pull request. The memory candidate is one line the engine builds (path and a capped reason, no reply text), shown in the reply, and trusted only after a person merges it into `.mng/MEMORY.md`.
- A second disagreement, or a severity above the limit, gets one terminal `needs-owner` reply and label, even at the round cap. Only `disputed` replies count toward `disputes.max_rounds`; a reply the model found unclear is marked as seen without a round. The verdict is `needs owner` while a thread's latest bot action is `needs-owner`, until an admin or an allowed login resolves it.

## Consequences

- An unauthorized comment costs one short runner job with no secret; it never reaches the tailnet or the endpoint.
- A writer can still read the endpoint key through a `push` workflow of their own branch, as before; a deployment environment whose secrets only the default branch can use is the protection, and the README says so.
- Replies are answered within the schedule interval, not at once.
- `needs-owner` holds a pull request until an admin acts; a writer resolving the thread or removing the label does not clear it.
- Rejected: a `pull_request_review_comment` trigger with a `workflow_run` hand-off (the receiving workflow's file comes from the merge ref, `workflow_run` matches workflows by name and trusts no payload field enough to find the pull request); `author_association` as the check (a member or collaborator can have no write access); `maintain` or `write` for every command by default (manual runs skip the run limit); a synthetic depth label.

## Related

- `docs/spec.md`: Pipeline, Converse; CI, commands
- ADRs 0006, 0007, 0008
