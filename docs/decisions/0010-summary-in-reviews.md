# ADR 0010: The summary is the body of the bot's review

**Status:** Proposed; ADR 0011 gives the review the verdict's state
**Date:** 2026-11-23

## Context

Publish mode (ADR 0007) wrote a sticky summary as a conversation comment and, beside it, a `COMMENT` review that held the new inline threads under a one-line body pointing at the summary. A reader saw two entries per run, the review that notified them said nothing, and other review bots post one review whose body is the summary. The summary's hidden marker also holds state every step reads: the run count, manual runs, the last finished head, unthreaded bugs and the threads that wait for the owner (ADR 0009). That state needs a home that survives a writer hiding the bot's text and that the reserve token (pull requests write only) can edit.

## Decision

- Each publishing run writes one review: `POST /pulls/{n}/reviews` with the summary as `body` and the run's new line threads as `comments[]`, on the reviewed head. The bot posts no summary comment any more. Comments on a whole file still go one by one before the review, since a review's comments take no file subject.
- A run edits the body of the bot's newest summary review (`PUT /pulls/{n}/reviews/{id}`) instead of posting, so it notifies no one, when the current identity wrote that review, it is not hidden, its state is the one the run would post, and the run posted no thread. Otherwise it posts a new review. An edit GitHub answers with 404 posts a new review.
- After every write the bot hides as outdated (`minimizeComment`, classifier `OUTDATED`) each earlier review of an owned identity that has a body and is still visible, the one-line reviews of earlier versions included. A submitted review cannot be deleted, so one GitHub refuses to hide stays and the result reports `kept`; the next write tries again. Hiding a review leaves its inline threads as they are.
- The state lives in the marker at the end of the newest summary review of any owned identity: an unedited review of an owned bot whose body ends with `<!-- mng-review:summary {json} -->`. Hidden and dismissed reviews count, since their bodies stay readable through the API and a writer can hide the bot's review but cannot write one. Publishing, the publish gate, the prepare step, the authorize and reserve steps, the status sweep and the reply schedule read it there. The waiting list (`needsOwner`) is the union over every owned review and every owned summary comment, hidden ones included.
- Migration: with no summary review, the prior state is the old sticky comment, read as before (the current identity's oldest visible one, else another owned identity's). The first write carries its run count and waiting list over through the marker and hides every owned summary comment as outdated, deleting one only when GitHub refuses to hide it (a 404 on that delete counts as deleted).
- One comment GitHub cannot place fails the whole review with 422. The bot places line threads from the diff hunks as before, and when the review is still refused it posts it again with no `comments[]` and those findings listed in the body, where they count as bugs without a thread. A create with no answer or a 5xx is checked by reading the reviews again: a new review of the current identity with this body counts as the create; with none the write fails, the run reports `failed` and the status is set to `error`. That read keeps its own count of null nodes (ADR 0012): it comes after the decision and only looks for this review, so a node it leaves out marks no run incomplete, and when that node is the review itself the create stays unconfirmed and fails as above.
- Reserve counts a manual run in the marker of the newest summary review when the current identity wrote it, hidden or not; with no summary review, in the current identity's old sticky comment; otherwise it posts a `COMMENT` review with one status line naming the handle in a code span, over the carried marker. That is one timeline entry, which the command's own publish edits into the full summary or hides. Reserve hides nothing itself and still reads no GraphQL field that names a commit.
- A reply-only run (`review-converse.yml`) and an offline run write through the same path: they edit the newest review when it can be edited and otherwise post a new one with the previous body updated.
- The body is short enough to read in the timeline: the verdict line first, then the new findings and the threads waiting for the owner, rejected findings and what did not finish, and the agents table and the token line folded in `<details>`. Every size cap stays.
- Every writer still runs in the concurrency group `mng-review-publish-<pull request>` (ADR 0009), so two writers never read the same marker. The reconciliation of duplicate summary comments goes away: each new review hides the ones before it.

## Consequences

- A clean push that changes nothing edits the review in place and sends no notification; a push with new threads notifies once.
- Each new review hides the previous one, so the result reports `minimized` on most runs that post.
- Reviews of the token's identity count in GitHub's per-author review list. Their state, and so whether they change a pull request's review decision, is ADR 0011's, which also keeps an approval or change request from being edited onto a newer commit.
- A pull request opened before the change keeps its old sticky comment hidden, not deleted, unless GitHub refuses to hide it.
- A pull request with more than 2,000 reviews fails the read, as every other paged read does.

## Related

- `docs/spec.md`: Publish; CI in publish mode
- ADRs 0007, 0009
