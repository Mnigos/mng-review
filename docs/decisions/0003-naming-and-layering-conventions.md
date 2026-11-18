# ADR 0003: Naming, layering and test conventions

**Status:** Accepted
**Date:** 2026-11-18

## Context

Agents and humans need one predictable answer to "where does this file go and what is it", checked by tooling rather than review, from the first commit. The owner's other TypeScript repositories already answer most of it: NestJS-style role suffixes, Effect layering in `domain`, `application`, `infrastructure` and `presentation`, role subfolders, and Vitest specs next to their source. This repository adopts those rules. Some parts are new: it has a CLI, prompts and model tools, and it runs Effect tests. This ADR records the adopted rules and the additions.

## Decision

- Every `.ts` file under `apps/*/src` and `packages/*/src` is `<kebab-name>.<role>.ts` with a role from the table in `AGENTS.md`, or two roles for a file that belongs to another, the kind last (`finding.schema.types.ts`). `index.ts` (package entry) and `apps/cli/src/main.ts` (CLI entry) keep their names. Enforced by `mng-review/file-role-suffix`.
- The adopted table (`base`, `client`, `config`, `constants`, `context`, `contract`, `errors`, `handler`, `helper`, `layer`, `layers`, `mapper`, `middleware`, `parser`, `port`, `query`, `repository`, `router`, `runtime`, `schema`, `schemas`, `service`, `types`, `util`) gains five roles:
  - `command`: an `effect/cli` command, in `presentation/`.
  - `formatter`: turns results into CLI output (text or JSON), in `presentation/`.
  - `prompt`: prompt text kept as a TypeScript constant, in any layer.
  - `tool`: one `effect/ai` tool definition, in `application/`.
  - `toolkit`: a group of tools with their handlers, in `application/`.
- Roles bound to a folder: `service`, `port`, `tool`, `toolkit` in `application/` (`service` also in `platform/`, for the shared `llm` and `git` services); `repository`, `parser`, `mapper`, `query` in `infrastructure/`; `layer` and `client` in `infrastructure/` or `platform/`; `command` and `formatter` in `presentation/`; `util` in `src/utils/`. Enforced as a warning by `mng-review/file-role-folder`.
- Three or more files of one role in one layer move into a role subfolder (`application/services/`, `domain/helpers/`). Review checks it.
- A service file in `modules/<module>/` is `<module>.service.ts` and exports `<Module>Service`. Enforced by `mng-review/module-name`.
- Specs sit next to their source with the same name plus `.spec.ts`. There is no `test/` folder and no `.test.ts`.
- Effect specs import `layer` from `@effect/vitest` and name its callback's parameter `test`: `layer(TestLayer)('Name', test => { test.effect(…) })`. Importing `it`, `effect`, `live`, `describe`, `expect`, `test` or `vi` from `@effect/vitest` is a lint error.

## Consequences

- A file's role and allowed folder are readable from its name, and lint fails on drift instead of review catching it.
- `@effect/vitest` exposes its Effect test methods on `it` (`it.effect`, `it.layer`), and `vitest/consistent-test-it` reads `import { it as test }` as `it`, so a plain `test(…)` next to it would fail lint. The `layer` callback receives the same methods under a parameter name the spec chooses, so every test reads `test`. `layer(Layer.empty)` covers an effect that needs no service.
- Vitest runs on Node 22 or newer, because oxlint's `RuleTester` (used by the lint rule specs) refuses other runtimes. Specs therefore never import `@effect/platform-bun`; a spec that needs a real process or file system provides it through a layer.
- Renaming a role or folder means updating `tooling/oxlint-plugin` with the files.

## Related

- `AGENTS.md`: Code, Testing
- `ARCHITECTURE.md`: Package layering
- ADR 0001: package layout
