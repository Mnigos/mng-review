# ADR 0011: The review state carries the verdict

**Status:** Proposed
**Date:** 2026-11-23

## Context

Since ADR 0010 each publishing run writes one review whose body is the summary, always as `COMMENT`. A reader still has to open the body to learn whether the bot found something blocking, and GitHub's review list and filters cannot tell a clean pull request from one with open bugs. Other review bots post `APPROVE` and `REQUEST_CHANGES`. Approving carries a risk a comment does not: where a branch rule requires approving reviews, a bot's approval may count toward it, and the reviewed change is text that can talk a model into finding nothing. The job token (`github-actions[bot]`) cannot approve by default: GitHub answers 422 "GitHub Actions is not permitted to approve pull requests." unless a repository setting allows it. Its `REQUEST_CHANGES` works and counts in the pull request's review decision; an app's reviews (author association `NONE`) do not.

## Decision

- The pure `getReviewEvent` in `packages/github/src/modules/publish/domain` picks the state of each run's review:
  - `REQUEST_CHANGES` while a confirmed bug thread at or above the severity floor is open, new or carried over (bugs without a thread count too), or a thread waits for the owner, whatever kind of run it is.
  - `APPROVE` for a full run that finished (a push, or a command that named no agent and whose head did not move) with nothing blocking and no other finding kept (no unverified finding, nothing below the floor, no nit), and for a reply-only run on a head whose last full review finished, once nothing blocks and no unverified or nit thread of the bot is open.
  - `COMMENT` for everything else: only unverified findings or nits, a partial or unfinished run, a command that named one agent, a head that moved, approval turned off.
  - An offline run judged nothing, so it keeps the state: it edits the bot's newest review whatever its state, or posts a `COMMENT` status review when it cannot.
- `verdict.mode` in `.mng/review.yml` turns approval off: `approve` (the default) lets a clean run approve, `preview` posts `COMMENT` where it would approve. The key was already in the schema and read by nothing; it is validated there.
- In token mode the bot never approves: whether the token's identity is `github-actions` decides, never a retry after the 422.
- The edit rule of ADR 0010 compares the state: a run edits the newest review only when its state is the one the run would post, so a change of state always posts a new review and hides the earlier ones.
- A stale change request must not outlive its findings. After a write whose state is `COMMENT`, the bot dismisses (`PUT /pulls/{n}/reviews/{id}/dismissals`) every review of an owned identity still in `CHANGES_REQUESTED`, with one fixed line as the reason. After `APPROVE` it dismisses those of other owned identities; the approval replaces the current identity's own. A dismissal GitHub refuses is left for the next run.
- Unchanged: the replies in threads, thread resolution, the `needs-owner` label, the `MNG Review` commit status and the per-agent check runs.

## Consequences

- A clean push by the app shows as an approval; a push that brings a bug back posts a new change request and hides the approval's body.
- In token mode a change request from `github-actions[bot]` blocks merging where a branch rule requires that no review requests changes, until a later run dismisses it or posts a newer review. An app's change request shows in the timeline but does not enter the review decision.
- Where a branch rule requires approving reviews, the app's approval may count toward it. A repository that does not want that sets `verdict.mode: preview`.
- The commit status and the review state say the same thing in two places; the status stays the gate a branch rule should require, since the sweep refreshes it when someone resolves a thread by hand and the review state changes only when a run writes.
- `verdict.never_approve` and `verdict.blocking_severity` stay in the schema and are still read by nothing.

## Related

- `docs/spec.md`: `review.yml`; Publish; CI in publish mode
- `README.md`: Publish mode
- ADRs 0007, 0008, 0010
