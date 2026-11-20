# Architecture

MNG Review reviews a change with a main reviewer and the agents a repository declares, then tries to refute every bug finding before it reports it. The behaviour is specified in `docs/spec.md`; this file maps it onto the code. Terms are defined in `UBIQUITOUS_LANGUAGE.md`.

## Layout

```
apps/
  cli/                     @mng-review/cli: the mng-review binary
    src/main.ts            the only file that runs effects (BunRuntime.runMain)
    src/presentation/      effect/cli commands and output formatters
  action/                  @mng-review/action: the GitHub workflow entry, shadow mode and the steps of publish mode
    src/main.ts            the only other file that runs effects
    src/application/       the shadow run (event, gate, probe, review) and the publish run
    src/infrastructure/    event parser, runner client (summary, masks)
    src/presentation/      job summary formatters
packages/
  domain/                  @mng-review/domain: Schema and pure logic
  engine/                  @mng-review/engine: Effect services
    src/platform/          config, llm, git
    src/modules/           routing, review, validation, converse, init, bench
  github/                  @mng-review/github: the GitHub API and publishing, used only by the action
    src/platform/          config and the bot identity, the REST and GraphQL client on effect/http
    src/modules/command/   the mention command grammar and who may run a command
    src/modules/publish/   which findings get a thread, comment and summary text, posting, re-check
    src/modules/status/    check runs, the MNG Review commit status, the status sweep
tooling/
  typescript-config/       @mng-review/typescript-config: the strict tsconfig preset
  oxlint-plugin/           @mng-review/oxlint-plugin: the mng-review/* lint rules
docs/
  spec.md                  the design
  decisions/               architecture decision records
```

`.github/workflows/review.yml` is the reusable workflow that runs `apps/action`.

## Package layering

Dependencies point one way: `apps/cli` and `apps/action` → `packages/engine` → `packages/domain`, and `apps/action` → `packages/github` → `packages/engine`. A package never imports an app, and an app never imports another app.

| Package  | May use                                                                    | Never                                                                              |
| -------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `domain` | `effect` (`Schema`, `Data`, `Predicate`, pure modules)                     | services, layers, I/O, a runtime                                                   |
| `engine` | `domain`, `effect` and its `cli`-free modules, `@effect/ai-openai-compat`  | running effects, printing to the terminal                                          |
| `cli`    | `engine`, `domain`, `effect/cli`, `@effect/platform-bun`                   | review logic                                                                       |
| `github` | `engine`, `domain`, `effect/http`                                          | review logic, running effects                                                      |
| `action` | `engine`, `domain`, `github`, `@effect/platform-bun`; a step's layers only | review logic, GitHub API calls of its own, GitHub in the step that calls the model |

Inside `engine`, `platform/` holds what every module shares and `modules/<module>/` holds one stage of the pipeline, split into `application/` (services, ports, model tools) and `infrastructure/` (adapters and parsers). ADR 0001 records the layout and ADR 0003 the file names.

## Pipeline

One run of `mng-review --base <ref>` goes through these steps. Numbers match the pipeline in `docs/spec.md`.

1. The CLI parses its flags and provides the engine's layers in `main.ts`.
2. `platform/config` reads `.mng/review.yml`, `.mng/CONTEXT.md`, `.mng/MEMORY.md` and `.mng/agents/*.md` from the working tree, or from `--rules-ref`, and decodes them with the schemas in `domain`. Unknown keys fail the run.
3. `platform/git` reads the change between the merge base and the head: changed paths, renames, the diff and file contents at a ref.
4. Gate (1): `domain` helpers apply `skip` and `features`.
5. Route (2): `modules/routing` selects agents by `when` rules, then asks the router model for agents to add and a risk level. A router failure falls back to path selection and `normal`.
6. Depth (3): the risk level or `depth` picks how many reviewer models run and whether the change is split into units.
7. Find (4): `modules/review` runs the main reviewer and each selected agent as a tool loop on `effect/ai`, with read-only tools over the repository. Findings with the same root cause merge. The main reviewer gets one continuation turn when it answers before reading every changed file.
8. Validate (5): `modules/validation` runs one fresh agent per bug finding to refute it, on a reviewer model that did not report it when `validator: cross`. A finding every reviewer model reported, or a run with one reviewer model, is validated once by a reviewer model in a fresh context. Nearby bugs from different finders are validated as a group, and the validator decides which of them are one defect.
9. The CLI formats the kept findings as text or JSON; the workflow entry writes them to the job summary.

Steps 2 to 8 run through `ReviewRunService` in `modules/review`, so the CLI, the benchmark and the workflow entry review a change the same way.

Publish (6) runs in the workflow's publish mode through `packages/github`; learn (8) follows.

Converse (7): `ReplyService` in `modules/converse` decides on an author's reply in one of the bot's threads. One fresh agent on a validator model, through `AgentLoopService` with the validator's read tools and `report_reply` as its finish tool, reads the claim; a `fixed` claim goes to `RecheckService` without the reply's text, and an `intentional` claim's evidence is checked in git. The decision itself is the pure `toReplyDecision` in `domain/src/converse`, with `getIntentionalLimit` and `toMemoryCandidate`. `makeReplyLayer` builds the service on the endpoint, like `makeValidatorLayer`. It reads no GitHub data: the workflow that finds the replies and applies the decisions is not wired in yet.

## GitHub workflows, shadow and publish mode

`.github/workflows/review.yml` checks out the caller's base commit (history only; the head commit is fetched as objects, never checked out) and this repository at the workflow's own commit, installs it with `--production --ignore-scripts`, optionally joins a tailnet, and runs `apps/action/src/main.ts` in the caller's checkout. `ShadowRunService` reads the event, skips forks before anything else, loads `.mng/` from the base commit, applies `skip`, asks `EndpointProbeService` for `GET /models`, and reviews base..head through `ReviewRunService`. The summary formatter escapes every text that came from a model or the repository. The result formatter writes the same outcome as JSON, with the review document `mng-review --json` prints (`toReviewJson` in the engine), and the workflow uploads it as the `mng-review-result` artifact. Nothing is posted. ADR 0006.

`review-publish.yml` runs two jobs that meet only through the outcome file. The `review` job has a read-only token and the endpoint secrets and runs `.github/actions/review` in publish mode, which is two steps of the entry. The prepare step (`MNG_REVIEW_MODE=prepare`) gets the read token and no endpoint variable: `PrepareRunService` makes the checks shadow mode makes before the probe, reads the sticky summary's marker for `limits.max_runs_per_pr` and incremental input, reads the bot's threads (a GitHub error counts as none), and writes the prepared file (`prepared-run.schema.ts`) into `RUNNER_TEMP` and the step output `ready`. A run the checks skipped never joins the tailnet. The review step (`MNG_REVIEW_MODE=review`) runs with `GITHUB_TOKEN` and `GH_TOKEN` empty and builds no GitHub layer: `ShadowRunService.review` loads the rules again and reviews, and `ThreadRecheckService.propose` hands the prepared threads whose file changed to the engine's `RecheckService` (the validator over the change from the thread's commit) and returns the ones it rejects as proposals. The entry turns the outcome and the proposals into the outcome file (`outcome-file.schema.ts`, redacted like the result file), writes it to `MNG_REVIEW_OUTCOME_PATH`, and sets the step output `publish` for a reviewed run the plan did not skip and for an offline endpoint; the action uploads it as `mng-review-outcome` for a day. The `publish` job has the write token and no endpoint or tailnet secret, and runs `.github/actions/publish`: it downloads this run's outcome and result, and the publish step (`MNG_REVIEW_MODE=publish`) parses the file with the schema (`reviewReportSchema` in `packages/github` for the report), checks its binding (repository, run, attempt, engine commit, pull request, base and head) against its own runner and event, and exits 1 without posting when the file is missing, too large, invalid or bound elsewhere. `PublishRunService` publishes from the parsed file alone, loads the rules again from the base commit, and calls no model. It hands the report and the proposals to `PublishService` in `packages/github`: it reads the bot's threads and sticky summary through `GitHubApiService`, applies the proposals through `ThreadResolutionService`, which resolves only threads its own fresh read still shows open, unanswered and on the proposal's fingerprint, folds `git diff` of merge base..head into the lines GitHub accepts comments on, plans the threads with the pure helpers in `modules/publish/domain` (published findings, duplicates, places), posts them, and edits the summary. `StatusReportService` then writes a check run per agent and the commit status, and the step adds `publish` to the result file. `main.ts` provides each mode only the layers it needs, so the review step cannot reach GitHub and the prepare and publish steps cannot reach the model. `status-sweep.yml` runs the entry with `MNG_REVIEW_MODE=sweep`, which loads the rules from `HEAD` of a default branch checkout and only refreshes statuses. A comment someone else edited is no longer the bot's. `GitHubConfig` holds the token and the bot identity it posts as: `GitHubWriteConfigLive` (publish, sweep) picks the job token or, with `MNG_REVIEW_APP_SLUG`, the app token and checks it against the minted slug; `GitHubReadConfigLive` (prepare) always reads with the job token. Once the rules are loaded, the entry provides `OwnedIdentities` (the token's identity and `identity.previous`), which the thread helpers, `SummaryCommentService` and `getStatus` read; `SummaryCommentService` moves the sticky summary from another owned identity to the current one. ADR 0009. Shadow mode builds no GitHub layer and never reads a token. ADR 0007.

`review-command.yml` runs a mention command in four jobs. `authorize` (`MNG_REVIEW_MODE=authorize`) parses the `issue_comment` event, loads the rules from the default branch and asks `CommandAuthorizeService` in `packages/github` (`parseMentionCommand`, the role, the pull request and `commands.max_runs`) over the read token; it never fails, and writes the outputs the later jobs start from. `reserve` (`MNG_REVIEW_MODE=reserve`) reads the pull request again, runs `PrepareRunService` for the base commit's gates and counts the run with `SummaryCommentService.reserveManualRun` over the write token. `review` and `publish` run the publish-mode steps with `MNG_REVIEW_TRIGGER=command`: the prepare step and the publish step read the pull request named by `MNG_REVIEW_TARGET_*` again instead of the event, the review step passes the named agent and the requested depth, and the publish step marks a run of one agent as partial. ADR 0009.

## Init

`mng-review init` writes `.mng/` at the repository root. The starter files and the conversion from `.macroscope/` are pure functions in `domain/src/init`; `modules/init` reads `.macroscope/` through the same confined working-tree reader as the rules, loads every generated `review.yml` and agent file as `RulesService` does (imports expanded), refuses symlinks on the way to its targets, and only then writes. It never runs a model.

## Bench

`mng-review bench` parses the benchmark file with the schema in `domain/src/bench`, loads the rules once, then plans and reviews each case with the same services as a review, each case on its own token ledger and review layer. Matching and totals are pure functions in `domain/src/bench/bench.helper.ts`.

## Model endpoint

`platform/llm` builds one OpenAI-compatible client from `MNG_REVIEW_LLM_URL` and `MNG_REVIEW_LLM_KEY` (read with `Config.Redacted`). Every role uses it with the model and effort from `models` in `review.yml`. A model that answers 429, 503 or "unknown model" is dropped for the rest of the run. Specs replace the endpoint with a test layer.

## Decision records

| ADR                                                            | Decision                                                                          |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [0001](docs/decisions/0001-package-layout.md)                  | Package layout: `domain`, `engine`, `cli` and tooling, one dependency direction   |
| [0002](docs/decisions/0002-effect-everywhere.md)               | Effect 4.1.4 for schemas, services, the CLI, processes, HTTP and the tool loop    |
| [0003](docs/decisions/0003-naming-and-layering-conventions.md) | File roles, layers, role subfolders and the test conventions, enforced by lint    |
| [0004](docs/decisions/0004-domain-text-and-hash-primitives.md) | Effect's `Yaml` and `Glob` and `node:crypto` in `domain`; no third-party parsers  |
| [0005](docs/decisions/0005-unverified-findings.md)             | A third verdict, `unverified`, for findings that rest on a dependency's behaviour |
| [0006](docs/decisions/0006-ci-shadow-mode.md)                  | `pull_request_target` with the base checked out only; shadow mode posts nothing   |
| [0007](docs/decisions/0007-publish-mode.md)                    | Publish mode: its own workflow, comments only, marked threads, no duplicates      |
| [0008](docs/decisions/0008-thread-resolution-and-status.md)    | The bot resolves its fixed threads; the status counts open bug threads            |
