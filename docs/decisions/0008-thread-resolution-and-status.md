# ADR 0008: The bot resolves its own fixed threads, and the status counts open bug threads

**Status:** Proposed
**Date:** 2026-11-19

## Context

Publish mode (ADR 0007) posts a thread per finding and a sticky summary. A pull request moves on: the author fixes findings, resolves threads by hand, and pushes again. The bot needs to close what is fixed, show a gate a repository can require, and not spend the endpoint on every push of a long pull request. Each part decides which threads the bot may touch and what counts as blocking.

## Decision

- The bot only touches its own threads (ADR 0007: first comment by the `github-actions` bot, unedited by anyone else, ending with its marker). It never resolves, edits or answers anyone else's thread.
- On every publish run, the bot's open `bug` and `unverified` threads are checked again when a commit since the thread's commit changed its file, the thread has no reply, and this run did not find the same problem again. The validator gets the finding rebuilt from the marker (title, trigger, impact) and the change from the thread's commit to the head. When it rejects the finding, the bot replies once ("Resolved: this no longer holds at `<head>`" and the reason, with a reply marker) and resolves the thread. Any other answer, or a failed write, leaves it open. At most eight threads are checked per run; nits are never checked or resolved by the bot. A thread with a reply is the author's conversation, which the reply flow handles (next stage).
- Each run writes one finished check run per agent that ran, `MNG Review · <agent>`: `success` when it finished clean, `neutral` otherwise. Check runs never block.
- The commit status `MNG Review` is the gate: `failure` while the bot has open `bug` threads (unverified threads never count) or the verdict is `needs owner`, `error` when the run did not finish and nothing blocks, `success` otherwise. A thread resolved by a person counts as dismissed: it no longer blocks, and a finding found again under it is listed in the summary as found again, not blocking, until a commit touches its code.
- `status-sweep.yml`, a reusable workflow a repository runs on a schedule, refreshes the status of open pull requests whose head already carries the bot's status, from the bot's open bug threads now. It runs no model, reads no endpoint secret, and has `statuses: write` and read access only. It turns `failure` into `success` when the last thread is resolved and keeps `error` until a run finishes.
- `limits.max_runs_per_pr` is read from the sticky summary's marker before the endpoint is probed. At the limit a run is skipped with the reason in the job summary; a manual command (next stage) and a pull request that just became ready for review still run.
- Agents with `input: incremental` review only the files changed since the head the summary's marker names, when that commit is an ancestor of the head and differs from it; an agent with none left is skipped and says since when. `full_diff` and `metadata` agents, a run after a force-push and a run on the same head see the whole change.

## Consequences

- A fix closes its thread without anyone clicking, and the status turns green when the last bug thread closes, by a push or by hand within one sweep interval.
- The validator can resolve a thread whose finding still holds when it misreads the change; the reply names the head and the reason, and a later run posts the finding again when it finds it.
- Resolving by hand is a dismissal anyone with write access can make; the summary still lists the finding when it is found again.
- The run count lives in an issue comment; editing it makes the comment no longer the bot's, and the bot then starts a new summary with the count at one. Deleting it does the same. Writers can therefore reset the count; the limit guards against loops and accidents, not against people with write access.
- Rejected: a status that counts unverified threads (they rest on behaviour the repository cannot show); a sweep that runs the model; resolving threads that have replies before the reply flow reads them.

## Related

- `docs/spec.md`: Pipeline, Publish and Converse; CI in publish mode
- ADR 0007
