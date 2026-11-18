# ADR 0001: Package layout with domain, engine and cli packages

**Status:** Accepted
**Date:** 2026-11-18

## Context

The first engine prototype was one package with config, routing, the model client and the CLI side by side in `src/`. The same review has to run three ways: from the CLI, from a GitHub workflow and as a library. Each way needs the same rules (config schema, agent selection, findings) but its own entry point and output. The owner wants the split in place before features land, so later stages add packages instead of moving code.

## Decision

- `packages/domain` (`@mng-review/domain`): Effect `Schema` definitions and pure logic: the `review.yml` and agent file schemas, selection rules, findings, fingerprints, severities. It depends on `effect` only and has no services, layers, I/O or runtime.
- `packages/engine` (`@mng-review/engine`): Effect services and their layers. `src/platform/{config,llm,git}` holds what every module shares; `src/modules/{routing,review,validation}/{application,infrastructure}` holds one pipeline stage each. It depends on `domain` and `effect`.
- `apps/cli` (`@mng-review/cli`): the `mng-review` binary on `effect/cli`. `src/main.ts` is the only file that runs effects; commands and formatters sit in `src/presentation/`.
- `tooling/typescript-config` (the strict tsconfig preset) and `tooling/oxlint-plugin` (the `mng-review/*` rules).
- Dependencies point one way: `cli` → `engine` → `domain`. A package never imports an app.
- Workspaces use the `@mng-review/*` scope and stay private. A later stage publishes a bundled build of `apps/cli` to npm as `@mnigos/mng-review`, with the `mng-review` binary, so users install one package with no workspace dependencies. Nothing is published in this stage.
- `apps/action` (the GitHub workflow entry) and `packages/github` (threads, summary, checks, commands) arrive with stages 3 and 4.

## Consequences

- `domain` has no services so that the CLI and the future action can share the rules without building a layer, and so specs test them as plain functions. Anything that reads a file, runs git or calls a model is a service in `engine`.
- Every workspace declares the workspace packages it imports; Bun's isolated linker does not hoist undeclared ones.
- Each package has its own `package.json`, tsconfig, Vitest project and lint scope, so a new package costs a few files.
- The published name differs from the workspace names. The bundling step (stage 3 or later) has to inline `domain` and `engine` into the CLI build.
- Rejected: one package with folders (the action would ship the CLI and its dependencies), and services in `domain` (it would need a runtime and layers to test plain rules).

## Related

- `ARCHITECTURE.md`: Layout, Package layering
- `docs/spec.md`: Packages
- ADR 0002: Effect in every package
- ADR 0003: naming and layering conventions
