# ADR 0012: The risk rating is a commit status the app grants last

**Status:** Proposed; amends ADR 0009's rule that an edit starts nothing
**Date:** 2026-11-24

## Context

A repository can let a merge tool merge low-risk pull requests without the owner. Today a person or an agent sets a risk label, and anyone with write access can set a label. The rating then decides what merges without the owner, so it is a permission: it must come from a writer the pull request cannot impersonate, it must never walk down, and it must be revoked before anything that could change it is written. A model rates the change, and the change is text that can argue for a lower level, so the paths that matter most cannot depend on the model. GitHub keeps every commit status and cannot delete one, so statuses can carry history; a status sits on a commit, while two pull requests can share a head.

## Decision

- **The permission is a commit status.** The app writes `MNG Review risk` on the head: `success` at Low and Medium, `failure` at High, `error` when not rated. Its description has exactly one form, `v1 pr=<n> <low|medium|high|none> floor=<yes|-> base=<40 hex> rules=<12 hex> nonce=<16 hex>`, at most 121 characters. Every reader takes only the app's statuses whose `pr` is its own pull request, and rejects any other text. Only `success` at `low` or `medium` grants. The label is display only, and `MNG Review risk` is never a required check, so the owner can still merge by hand.
- **Only the app rates, from an environment.** A run rates only with `app-slug` and `app-environment`. The app key lives in an environment whose deployment branches are the default branch only, so a pull request's own workflow is refused it. Jobs that hold the key check out the base commit only, read the head as git objects, give the model read-only tools and pass event text through environment variables or files.
- **The rater** is a step after Validate. It reads the rubric (`.mng/risk.md` and its imports, from the base commit), the complete file list, the budgeted diff, the kept findings, the floors that applied and the previous rating, never the title, description, comments or commit messages. A rating counts only when every changed hunk was in its prompt or in ranges it read.
- **Floors come from the complete change.** Publish runs `git diff --no-renames --raw --numstat -z` itself; a rename counts at both paths. The built-in floor sets High and `floor=yes` for any change under `.github/**`, `.mng/**`, `CODEOWNERS` at the root or in `docs/`, any `.gitattributes`, every file the rules resolve to, and any submodule, symlink or mode change. No config removes it. Configured floors (`risk.floors`, Medium by default) mark critical areas. A binary outside `risk.assets` leaves the pull request unrated; a count that does not parse means High.
- **Ratings never walk down.** The level is the highest of the model's level, every floor, Medium for a router `risky`, High for an open or carried confirmed High or Critical bug, the marker's highest and the held level (the highest level on any app status for the pull request, `error` included). A High stays High until the pull request merges or closes. The app keeps a marker comment with the highest level and the rated heads, trusted only while the app is its last editor and rebuilt from the app's own statuses otherwise.
- **Revoke first, grant last.** Every writer of the status runs in one job-level concurrency group per pull request. A publish first writes `error` with the higher of the held level and the level it will publish and reads it back, then posts, updates the marker and the label, re-reads that the head, its nonce and the marker are unchanged, and writes the grant as its last write. A failure or cancel after step 1 leaves `error` at that level. A failed read or write before step 1 fails the job, so the merge tool sees a run that did not finish.
- **Who counts.** One rule, the engine's reply rule, decides whose comments hold a pull request or start work: a person, not posted through an app and not a bot the repository owns, with write access by collaborator role. `author_association` decides nothing. Commands keep the owner gate on top, and a refused command from such a person gets a denial answer. A `review` command rates a head at most `risk.reviews_per_head` times.
- **Answers name what they answered.** Each app answer ends with its one marker, which lists the comments it handled with their ids, edit times and the first 16 hex characters of the body digest. The merge tool treats a comment as answered only when an answer names its current version.
- **An edit now starts a run.** The review workflows listen to `issue_comment` `created` and `edited`, and every per-pull-request writer is named `mng-review-risk-<number>`, so the merge tool can see a writer in flight. This amends ADR 0009, which said an edit starts nothing: an edited conversation comment now starts a named run, and an edited command gets a denial ("the comment changed; post a new command") instead of running. Review events reach the default-branch workflow through a bridge that holds no secret.
- **Pure parts live in `packages/domain`:** the `risk` config schema and preset, the description schema with its parser and formatter, the grant and held-level rules, the built-in floor, the floor diff parser, the combine rule, the run-kind table, the acted-on role table and bot exclusion, the answer entry schema, the digests, and one fixture table of command grammar, digest and author cases that the engine and the merge tool both run.

## Consequences

- `risk.enabled` is off by default; nothing changes for a repository that does not turn it on.
- A change to `.github/`, `.mng/`, ownership or the rubric always goes to the owner, and so does every later head of that pull request once it was rated High.
- A model fooled by the change can at worst move a change outside the floors between Low and Medium, or fail to raise one to High. The bench measures how often with injection twins; nothing guarantees it.
- The merge tool still has a window of a few seconds between its final read and the merge call. Closing it needs the merge to run inside the per-pull-request group as an app job with contents write.
- A new pull request with the same change starts with no history. Floors and threads still apply; only the model's level can come out lower.

## Rejected

- A label as the permission: anyone with write access sets labels, and the job token can too.
- The job token as the writer: a same-repository pull request can add a workflow that writes statuses and labels as `github-actions[bot]`.
- Lowering a rating on a later head, or an override that lowers one: the owner merges by hand instead.
- `author_association` for who counts: a private organization member shows as `CONTRIBUTOR`, and it does not see custom roles (ADR 0009).

## Related

- `docs/spec.md`: `review.yml`; Risk rating
- ADRs 0007, 0008, 0009, 0011
