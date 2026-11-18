# Architecture

MNG Review reviews a change with a main reviewer and the agents a repository declares, then tries to refute every bug finding before it reports it. The behaviour is specified in `docs/spec.md`; this file maps it onto the code. Terms are defined in `UBIQUITOUS_LANGUAGE.md`.

## Layout

```
apps/
  cli/                     @mng-review/cli: the mng-review binary
    src/main.ts            the only file that runs effects (BunRuntime.runMain)
    src/presentation/      effect/cli commands and output formatters
packages/
  domain/                  @mng-review/domain: Schema and pure logic
  engine/                  @mng-review/engine: Effect services
    src/platform/          config, llm, git
    src/modules/           routing, review, validation, init
tooling/
  typescript-config/       @mng-review/typescript-config: the strict tsconfig preset
  oxlint-plugin/           @mng-review/oxlint-plugin: the mng-review/* lint rules
docs/
  spec.md                  the design
  decisions/               architecture decision records
```

`apps/action` (the GitHub workflow entry) and `packages/github` (threads, summary, checks and commands) arrive with stages 3 and 4.

## Package layering

Dependencies point one way: `apps/cli` → `packages/engine` → `packages/domain`. A package never imports an app.

| Package  | May use                                                                   | Never                                     |
| -------- | ------------------------------------------------------------------------- | ----------------------------------------- |
| `domain` | `effect` (`Schema`, `Data`, `Predicate`, pure modules)                    | services, layers, I/O, a runtime          |
| `engine` | `domain`, `effect` and its `cli`-free modules, `@effect/ai-openai-compat` | running effects, printing to the terminal |
| `cli`    | `engine`, `domain`, `effect/cli`, `@effect/platform-bun`                  | review logic                              |

Inside `engine`, `platform/` holds what every module shares and `modules/<module>/` holds one stage of the pipeline, split into `application/` (services, ports, model tools) and `infrastructure/` (adapters and parsers). ADR 0001 records the layout and ADR 0003 the file names.

## Pipeline

One run of `mng-review --base <ref>` goes through these steps. Numbers match the pipeline in `docs/spec.md`.

1. The CLI parses its flags and provides the engine's layers in `main.ts`.
2. `platform/config` reads `.mng/review.yml`, `.mng/CONTEXT.md`, `.mng/MEMORY.md` and `.mng/agents/*.md` from the working tree, or from `--rules-ref`, and decodes them with the schemas in `domain`. Unknown keys fail the run.
3. `platform/git` reads the change between the merge base and the head: changed paths, renames, the diff and file contents at a ref.
4. Gate (1): `domain` helpers apply `skip` and `features`.
5. Route (2): `modules/routing` selects agents by `when` rules, then asks the router model for agents to add and a risk level. A router failure falls back to path selection and `normal`.
6. Depth (3): the risk level or `depth` picks how many reviewer models run and whether the change is split into units.
7. Find (4): `modules/review` runs the main reviewer and each selected agent as a tool loop on `effect/ai`, with read-only tools over the repository. Findings with the same root cause merge.
8. Validate (5): `modules/validation` runs one fresh agent per bug finding to refute it, on a reviewer model that did not report it when `validator: cross`. A finding every reviewer model reported, or a run with one reviewer model, is validated once by a reviewer model in a fresh context.
9. The CLI formats the kept findings as text or JSON.

Publish (6), converse (7) and learn (8) run on GitHub and arrive with `packages/github`.

## Init

`mng-review init` writes `.mng/` at the repository root. The starter files and the conversion from `.macroscope/` are pure functions in `domain/src/init`; `modules/init` reads `.macroscope/` through the same confined working-tree reader as the rules, decodes every generated `review.yml` and agent file with the rule schemas, and only then writes. It never runs a model.

## Model endpoint

`platform/llm` builds one OpenAI-compatible client from `MNG_REVIEW_LLM_URL` and `MNG_REVIEW_LLM_KEY` (read with `Config.Redacted`). Every role uses it with the model and effort from `models` in `review.yml`. A model that answers 429, 503 or "unknown model" is dropped for the rest of the run. Specs replace the endpoint with a test layer.

## Decision records

| ADR                                                            | Decision                                                                         |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [0001](docs/decisions/0001-package-layout.md)                  | Package layout: `domain`, `engine`, `cli` and tooling, one dependency direction  |
| [0002](docs/decisions/0002-effect-everywhere.md)               | Effect 4.1.4 for schemas, services, the CLI, processes, HTTP and the tool loop   |
| [0003](docs/decisions/0003-naming-and-layering-conventions.md) | File roles, layers, role subfolders and the test conventions, enforced by lint   |
| [0004](docs/decisions/0004-domain-text-and-hash-primitives.md) | Effect's `Yaml` and `Glob` and `node:crypto` in `domain`; no third-party parsers |
