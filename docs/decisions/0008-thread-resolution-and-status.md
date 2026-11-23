# ADR 0008: The bot resolves its own fixed threads, and the status counts open bug threads

**Status:** Proposed
**Date:** 2026-11-19

## Context

Publish mode (ADR 0007) posts a thread per finding and a sticky summary. A pull request moves on: the author fixes findings, resolves threads by hand, and pushes again. The bot needs to close what is fixed, show a gate a repository can require, and not spend the endpoint on every push of a long pull request. Each part decides which threads the bot may touch and what counts as blocking.

## Decision

- The bot only touches its own threads (ADR 0007: first comment by an owned bot identity, unedited by anyone else, ending with its marker; ADR 0009). It never resolves, edits or answers anyone else's thread.
- On every publish run, the bot's open `bug` and `unverified` threads are checked again when a commit since the thread's commit changed its file, the thread has no reply, and this run did not find the same problem again. The validator runs in the review job, over the threads the prepare step read: it gets the finding rebuilt from the marker (title, trigger, impact) and the change from the thread's commit to the head, and a rejection becomes a proposal in the outcome file. The publish job writes the reply, with no model call: the bot replies once ("No longer found at `<head>`" and the reason, with a reply marker). That reply closes the thread for the bot: a thread whose latest comment is it counts as resolved for the verdict, the status and the sweep. The bot also asks GitHub to resolve the thread, which succeeds only with `contents: write`; the publish workflow does not ask for that (it would let the job push to unprotected branches), so a person resolves the thread on GitHub when they want it hidden. Before it writes, the bot reads the threads again and leaves one that someone answered or edited meanwhile. Any other answer, or a failed write, leaves it open. A thread whose commit is no longer an ancestor of the head (a force-push) is not checked. At most eight threads are checked per run, a different batch each run when there are more; nits are never checked or resolved by the bot. A thread with a reply is the author's conversation, which the reply flow handles (ADR 0009); the re-check still skips it, so no thread is decided twice in one run.
- Each run writes one finished check run per agent that ran, `MNG Review · <agent>`: `success` when it finished clean, `neutral` otherwise. Check runs never block.
- The commit status `MNG Review` is the gate: `failure` while the bot has open `bug` threads (unverified threads never count) or bugs without a thread (in the summary, or unposted) on the head: the last full review's and those of every run on that head since that did not replace it (a partial run, or a full run that did not finish), which the summary's marker records until the next full review that finishes replaces them, or the verdict is `needs owner`, `error` when the run did not finish or the reviewer was offline and nothing blocks, `success` otherwise. The description of a run that did not finish says so, also when bugs block, so the sweep never turns it green. A thread resolved by a person counts as dismissed: it no longer blocks, and a finding found again under it is listed in the summary as found again, not blocking, until a commit touches its code.
- `status-sweep.yml`, a reusable workflow a repository runs on a schedule and after a reply (ADR 0009), refreshes the status of open pull requests whose head already carries the `MNG Review` status of an owned bot identity, from the open bug threads of the owned identities now and the bugs without a thread the summary's marker records for that head. It reads `identity.previous` from the default branch. It runs no model, reads no endpoint secret, and has `statuses: write` and read access only. It turns `failure` into `success` when the last thread is resolved and the run had finished, keeps an unfinished run's status at `error` or `failure` until a run finishes, and reads the status again just before it writes so it leaves a newer one alone.
- `limits.max_runs_per_pr` is read from the sticky summary's marker by the prepare step, before the endpoint is probed. At the limit a run is skipped with the reason in the job summary; a manual command (next stage) and a pull request that just became ready for review still run.
- Declared agents with `input: incremental` review only the files changed since the last head a run reviewed completely (the summary's marker; an offline or unfinished run does not move it), when that commit is an ancestor of the head and differs from it; an agent with none left is skipped and says since when. The main reviewer, `full_diff` and `metadata` agents, a run after a force-push and a run on the same head see the whole change.

## Consequences

- A fix closes its thread for the bot without anyone clicking, and the status turns green when the last bug thread closes, by a push or by hand within one sweep interval. On GitHub the thread stays open, with the bot's reply as its last comment, until a person resolves it; a reply after the bot's reopens it for the bot.
- The validator can resolve a thread whose finding still holds when it misreads the change; the reply names the head and the reason, and a later run posts the finding again when it finds it.
- Resolving by hand is a dismissal anyone with write access can make; the summary still lists the finding when it is found again.
- A publish run that lands between the sweep's last read and its write can be overwritten until the next sweep or push; a caller can avoid that by giving the sweep and the review one concurrency group.
- The run count lives in an issue comment; editing it makes the comment no longer the bot's, and the bot then starts a new summary with the count at one. Deleting it does the same. Writers can therefore reset the count; the limit guards against loops and accidents, not against people with write access.
- Rejected: `contents: write` for the publish job so the bot can resolve threads itself; a status that counts unverified threads (they rest on behaviour the repository cannot show); a sweep that runs the model; resolving threads that have replies before the reply flow reads them.

## Related

- `docs/spec.md`: Pipeline, Publish and Converse; CI in publish mode
- ADR 0007
