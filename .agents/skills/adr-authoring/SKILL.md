---
name: adr-authoring
description: Creates or updates MNG Review architecture decision records under docs/decisions. Use when the user asks for an ADR, decision record, architecture decision, accepted/proposed decision, or when a change makes a hard-to-reverse architectural trade-off.
---

# ADR Authoring

Use ADRs for durable architecture decisions, not routine implementation notes.

## When An ADR Qualifies

Create or update an ADR only when all are true:

- The decision is hard to reverse.
- The decision would be surprising without context.
- The decision involved a real trade-off.

A new convention (a file role, a layer rule, a test pattern) qualifies too: record it in an ADR and in `AGENTS.md`, and add its lint rule when one can check it.

## Flow

1. Read existing ADRs in `docs/decisions`.
2. Read `UBIQUITOUS_LANGUAGE.md`, `ARCHITECTURE.md`, `docs/spec.md` and the code relevant to the decision.
3. Choose the next number by scanning all `docs/decisions/*.md` files and parsing the leading ADR number.
4. Use `docs/decisions/NNNN-short-slug.md` and the template below.
5. Link to `UBIQUITOUS_LANGUAGE.md` instead of duplicating term tables; add new terms there.
6. Mark new ADRs `Proposed` unless the user says the decision is accepted.
7. Add the ADR to the decision table in `ARCHITECTURE.md`.

## Template

```md
# ADR NNNN: {Short title of the decision}

**Status:** Proposed
**Date:** YYYY-MM-DD

## Context

{What is happening, what constraints matter, and why this decision is needed.}

## Decision

{What we decided and why.}

## Consequences

{Non-obvious downstream effects, trade-offs, rejected alternatives and follow-up work.}

## Related

- `ARCHITECTURE.md`: {section}
- ADR NNNN: {related decision}
```

A later change to an accepted ADR goes into an `## Update YYYY-MM-DD` section above `## Related`, not into a rewrite of the original decision.

## Rules

- Keep ADRs as short as the decision allows, but complete enough for a future agent to understand why.
- Record rejected alternatives when they would otherwise be suggested again.
- Include concrete dates, pull requests and affected packages or modules when they clarify scope.
- Use `docs/decisions`, not `docs/adr`.
- The repository is public: no private repository names, product names, people or accounts.
- Do not create GitHub issues from an ADR unless the user asks.
- Do not commit ADR changes unless explicitly asked.
