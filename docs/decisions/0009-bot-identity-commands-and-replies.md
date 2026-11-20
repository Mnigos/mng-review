# ADR 0009: The bot may post as a GitHub App, and switching keeps one set of threads

**Status:** Proposed
**Date:** 2026-11-20

## Context

Publish mode (ADR 0007) posts with the job token, as `github-actions[bot]`. That name is shared with every other workflow in the repository, events made with the job token start no workflows, and a handle a person can mention needs an account of its own. A GitHub App gives the bot its own name, but its key can write wherever the app is installed, and a repository that switches already has threads and a summary written by `github-actions`. The commands and replies of the next layers build on the identity this record sets.

## Decision

- The app is optional. With `app-slug` and the secrets `app-client-id` and `app-private-key` set, every write comes from the app. Without them nothing changes. Setting only some of the three fails the job before any write.
- Only the jobs that write reference the two secrets: `publish` in `review-publish.yml` and `sweep` in `status-sweep.yml`. The review job, which calls the model, never holds the key. A writing job mints an installation token with `actions/create-github-app-token`, pinned by commit, after its checkouts. The token covers the calling repository only (no `owner`, no `repositories`) and the permissions the job writes with: pull requests, checks and statuses write for publishing, statuses write and pull requests read for the sweep. The action revokes it when the job ends. A failed mint fails the job, and nothing falls back to the job token.
- Every job that runs the entry gets the slug as `MNG_REVIEW_APP_SLUG`. A writing step also gets the app token and the slug the token was minted for, and exits 2 before any request when that slug differs from the configured one without regard to case, when the slug is not a valid app slug, or when a token of the other mode is set. In app mode the entry never receives the job token, which then only checks out and fetches. The prepare step reads with the job token and needs the slug only to know which bot wrote the summary and the threads.
- The owned identities are the token's identity and the slugs in `identity.previous` of `.mng/review.yml`, read where the rules are read: the base commit for a push, the default branch for the sweep, so a pull request cannot widen them for itself. The preset is `[github-actions]`. A repository that leaves the app sets it to the app's slug; `[]` drops the trust once the pull requests opened before a switch are closed.
- A comment is the bot's when its author is a `Bot` whose login is owned, compared without case, and its editor is `null` or that same bot. An edit by another bot, even an owned one, ends the ownership.
- The bot creates as its current identity, edits and deletes only what that identity wrote, and replies in a thread of any owned identity. A reply of any owned identity closes a thread for the bot's counts, so the app's "no longer found" reply closes a `github-actions` thread. The only thing it does to another identity's comment is hide or delete a superseded summary.
- The summary is the current identity's oldest summary when it has one; otherwise the oldest visible summary of another owned identity is the prior state. A write then creates the current identity's summary over that marker, so the run count and last head carry over, and hides the old summary as outdated. When GitHub refuses to hide it (a 4xx other than a rate limit, or GraphQL errors of type `FORBIDDEN`, `NOT_FOUND` or `UNPROCESSABLE`), the bot deletes it, and a 404 on that delete counts as deleted; when hiding gets no answer, a 5xx or a rate limit, which may still pass later, or GitHub refuses the delete too, it stays and the result file reports `kept`. An offline run moves the summary the same way, with the marker set to unfinished, so the sweep never reads the old summary's finished run for a newer head. Summaries of the current identity that two runs created at once are deleted on every write except the oldest; a 404 on that delete counts as done. While more than one such summary is visible, the sweep leaves the status as it is. Every later write tries the cleanup again while such a summary is visible. A hidden summary is never read.
- Two runs that create the summary at once leave one: after a create the bot reads again, and when an older summary of its identity exists it renders over that one's marker, edits it and deletes its own new comment. When that edit fails, the bot deletes its own new comment and the write fails, so the run reports `failed` and the next run starts from one summary. A create with no answer or a 5xx is followed by a read before anything else: the newest summary of the current identity that was not in the read before the create and has this run's body is taken as this run's own create, and the oldest summary of the identity is then kept or edited the same way; with none the write fails and the next run tries again.
- The status the sweep refreshes is the newest `MNG Review` status set by a `Bot` with an owned REST login (`<slug>[bot]`). Check runs carry no ownership check: each run creates them with its token and never updates them.
- The job token of the publish job keeps write in app mode, because job permissions are static text and token mode needs them. The job that holds it also holds the app key, which can do more, so the token adds no reach.
- The user login that matches the app's slug is reserved, for example with an empty organization of that name, so a mention of the handle can never reach someone else's account; a mention of an organization notifies nobody. The `mng-review` login is reserved this way.

## Consequences

- Comments, statuses and check runs the app makes start the repository's other workflows, which writes with the job token never did.
- A required `MNG Review` check bound to GitHub Actions blocks every pull request once the app sets the status. The check's source must be set to any source before the switch and to the app after it.
- While `github-actions` is in `identity.previous`, another workflow that posts as `github-actions[bot]` can still plant a marker, as ADR 0007 records.
- After `identity.previous: []` on a pull request opened before the switch, the bot posts the old threads' findings again, and an old summary it could not hide stays visible.
- Accepted race: two runs writing one summary while one of their creates gets no answer can count one run twice. That only makes `max_runs_per_pr` stricter.
- A reconciliation that fails after a create fails the run instead of leaving two summaries of the current identity; the next run starts from one.
- Rejected: the identity inside the marker (GitHub attests the author, the marker is text); numeric bot ids in the config (slugs are what GraphQL and REST return and what a person can read); a second, read-only family of workflow files for app mode; editing the old summary in place (it breaks the rule that the bot edits only what its current identity wrote, and the summary would keep the old name).

## Related

- `docs/spec.md`: `review.yml`; CI in publish mode
- ADRs 0007 and 0008
