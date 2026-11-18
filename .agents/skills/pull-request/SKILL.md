---
name: pull-request
description: Use when the user asks to open, create, or prepare a GitHub pull request from the current branch of MNG Review.
---

# Pull Request

Use this skill when the user asks for a PR.

## Related Skills

- Commits follow Conventional Commits; `commitlint` checks them in the `commit-msg` hook and in CI.
- Use `adr-authoring` when the change makes a hard-to-reverse architecture decision.

## Flow

1. Inspect branch, status, recent commits, and diff against the base branch.
2. If uncommitted changes exist, identify those within the requested scope and commit only those. The PR request authorizes the necessary commits and push; do not ask for separate confirmation.
3. Fetch the base branch and rebase the PR branch onto the latest base before creating the PR.
4. Run `bun run check`, `bun run typecheck`, `bun run test` and `bun run build`; fix what fails before pushing.
5. Push the current branch.
6. Open a ready-for-review PR unless the user says otherwise. Dependent PRs form a native GitHub stack; never fake a stack with chained bases alone.
7. Write the description with the format below; include validation, important risks, and the linked issue when discoverable.
8. Before reporting the PR as ready, verify it on GitHub, not locally: `gh pr view --json mergeable,mergeStateStatus` shows `MERGEABLE` and `gh pr checks` has no failing or pending check for the current head. A local rebase or a green local check is not evidence; if anything is red, pending, or conflicting, say so instead of calling the PR ready.

## Description Format

The description is a guide for a reviewer, not a change log. A reviewer should absorb it in under a minute.

- Open with 2–3 short sentences: what was wrong or missing, what this PR does, what it leaves out. No heading above them.
- Then, in this order and only when non-empty: `## What changes`, `## How to review` (large PRs only: where to start, one sentence), `## Validation` (one sentence: what ran and the numbers), then `Closes #<issue>` when an issue exists.
- `What changes` is at most five bullets, each one line, each describing an effect a reviewer can see, not an internal mechanism.
- Hard caps: 120 words for a small PR, 200 for a large one. At most one backticked name per bullet or sentence, and only when the reviewer has to open it. No file inventories, no env var lists, no decision essays, no review-round history, no tool attribution.
- Anything longer belongs in `docs/spec.md`, `ARCHITECTURE.md` or an ADR; link it instead of repeating it.

## Rules

- Always open ready-for-review PRs unless the user says otherwise.
- A PR request authorizes scoped commits, push, and PR creation without separate permission.
- PR titles and commits use Conventional Commits with a workspace scope (`cli`, `domain`, `engine`, `oxlint-plugin`, `typescript-config`) or an area scope (`deps`, `ci`, `docs`).
- No AI attribution in the PR body, title or commits: no `Co-Authored-By`, no "Generated with", no model or tool names.
- The repository is public: never put private repository names, product names, people, hosts or accounts in a PR body or commit.
- Do not prefix branches with `codex/`, `claude/` or `t3code/`.
- Do not create GitHub comments, labels or discussions unless explicitly asked.
- Before creating a PR, run `git fetch origin <base>` and `git rebase origin/<base>`; after rebasing an already-pushed PR branch, push with `--force-with-lease`.
- Use `gh` for GitHub operations.
- Before editing files while preparing a PR, read at least 3 similar files.
