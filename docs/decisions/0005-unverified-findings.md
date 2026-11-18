# ADR 0005: A third verdict for findings that rest on a dependency's behaviour

**Status:** Proposed
**Date:** 2026-11-18

## Context

The validator tries to refute each bug finding and answered confirm or reject. It reads the repository through git, so the code of installed dependencies is never visible, and it was told to reject any claim that rests on behaviour the repository does not show. In a benchmark that rejected a real bug: a filter received a full URL from a framework callback while its check matched a path. Every premise about the repository's own code held; only the shape of the value the framework passes could not be read. Rejecting such findings loses real bugs; confirming them would let a guess about a library block a merge.

## Decision

- The validator has a third verdict, `unverified`, besides `confirm` and `reject`. It may use it only when every premise about the repository's code holds and it checked them, and the finding also rests on a dependency's documented behaviour. The answer names that behaviour in `premise`, one sentence naming the package, and cites the repository lines it checked as `evidence`.
- Type declarations, `package.json` versions and lockfile entries present in the repository count as evidence about a dependency.
- A finding that rests on dependency behaviour that is unlikely, or whose repository premise fails, is still rejected.
- An unverified finding is kept at the validator's severity, reported after confirmed and unvalidated findings, and placed in the summary: it never gets an inline thread and never counts as blocking.

## Consequences

- Real bugs that depend on a framework's or client library's behaviour reach the report instead of disappearing in validation, at the cost of some findings a reader has to check against the dependency's documentation.
- Blocking stays tied to what the repository proves.
- The benchmark counts unverified findings as kept, so they score as found when they match an expected entry.
- Rejected: reading `node_modules` (not in git, differs per machine, and the change under review could ship its own copy), and keeping such findings unvalidated (that status means the validator gave no answer, which hides the reason).

## Related

- `docs/spec.md`: Pipeline, Validate
