# ADR 0002: Effect for schemas, services, the CLI, processes, HTTP and the tool loop

**Status:** Accepted
**Date:** 2026-11-18

## Context

The engine runs several models in parallel against one endpoint, retries and drops failing models, caps tokens per run and per pull request, spawns git, and parses YAML, Markdown front matter, git output and model JSON. The prototype did this with Zod, hand-written concurrency and retry loops and `Bun.spawn`, and needed fakes threaded through every function to test it. Effect 4 ships a schema library, services with layers, a CLI parser, child processes, an HTTP client and a provider-agnostic language model module with tools in one versioned package.

## Decision

- Effect 4.1.4, pinned exactly in the workspace catalog with `@effect/platform-bun`, `@effect/vitest` and `@effect/ai-openai-compat` at the same version.
- `domain` defines every boundary shape with `Schema` and decodes untrusted input with it. Zod is not used.
- `engine` exposes `Context.Service` classes with `*Live` layers in the same file; every method is `Effect.fn('Service.method')`. Errors are `Schema.TaggedError`, the form the Effect 4 docs use.
- `apps/cli` builds its commands with `effect/cli` and runs them once in `main.ts` with `BunRuntime.runMain` and `BunServices.layer`.
- `platform/git` spawns git through `effect/process` (`ChildProcess`, `ChildProcessSpawner`); the CLI provides the Bun spawner.
- HTTP goes through `effect/http`.
- Each reviewer is a tool loop on `effect/ai` (`LanguageModel`, `Tool`, `Toolkit`) against `@effect/ai-openai-compat`, which speaks to any OpenAI-compatible chat completions endpoint.
- Concurrency, retries, timeouts and budgets use Effect (`Effect.forEach` with `concurrency`, `Schedule`, `Effect.timeout`, `Semaphore`, `Ref`). No hand-written queues, retry loops or counters.
- Effect documentation comes from the installed package (`effect/AGENTS.md`, `effect/ai-docs/`, `effect/src`), not from Effect 3 material.

## Consequences

- Specs replace the model, git and the file system with test layers, so no spec calls a real endpoint.
- Secrets read through `Config.Redacted` stay redacted in logs and errors until the client unwraps them (lint rule `mng-review/redacted-secret-config`).
- Running effects anywhere but `apps/cli/src/main.ts` is a lint error (`mng-review/no-default-runtime`), so library code always returns effects.
- `effect/cli`, `effect/ai`, `effect/process` and `effect/http` are marked unstable in 4.1.4. An Effect upgrade moves every package at once and may need code changes; the exact pin keeps upgrades deliberate.
- Contributors need to know Effect. `AGENTS.md` lists the patterns the code uses.
- Rejected: Zod with plain async functions (the prototype; concurrency, retries and test fakes were hand-written), and an official provider SDK per vendor (the tool must stay provider-agnostic).

## Related

- `ARCHITECTURE.md`: Package layering, Model endpoint
- ADR 0001: package layout
