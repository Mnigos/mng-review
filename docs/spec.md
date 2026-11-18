# MNG Review: specification

Pull request review by one built-in reviewer and the agents a repository declares. The engine is a Bun + TypeScript package (`@mnigos/mng-review`, binary `mng-review`) used three ways: a CLI, a reusable GitHub workflow and a library. It talks to any OpenAI-compatible chat completions endpoint.

## Packages

A Bun workspace on Effect 4. Dependencies point one way: `cli` and `action` use `engine`, which uses `domain`.

| Workspace | Package | Holds |
|---|---|---|
| `packages/domain` | `@mng-review/domain` | Schemas and pure logic: config and agent file schemas, selection rules, findings, fingerprints, severities. No services, no runtime. |
| `packages/engine` | `@mng-review/engine` | Effect services: config loading, git, the model endpoint, routing, review and validation. |
| `apps/cli` | `@mng-review/cli` | The `mng-review` binary on `effect/cli`; the only place that runs effects. |
| `apps/action` | `@mng-review/action` | The GitHub workflow entry; runs effects in its own `main.ts`. |
| `packages/github` | later | Threads, summary, checks and commands on GitHub (stage 4). |

A later stage publishes a bundled build of `apps/cli` as `@mnigos/mng-review`. ADR 0001 records the layout.

## Roles

The conductor is code. Models do five jobs:

| Role | Defined by | Job |
|---|---|---|
| Router | engine | adds agents the path rules missed and rates the risk of the change |
| Main reviewer | engine, steered by `.mng/CONTEXT.md` | finds bugs across files; runs on every change that is not `trivial` |
| Declared agents | `.mng/agents/*.md` | `kind: bug` specialists and `kind: nit` convention checks |
| Validator | engine | tries to refute each bug finding before it is posted |
| Verdict | engine | `ready`, `needs fixes` or `needs owner` |

The router model only routes. The main reviewer and the validator run on the reviewer models, by default `gpt-6.1-sol` and `claude-opus-5-5` at high effort. Declared agents run on `models.agents`, by default `gpt-6.1-sol` at high effort. All models go through the same OpenAI-compatible endpoint.

## `.mng/` layout

```
.mng/
  review.yml     # settings
  CONTEXT.md     # for the main reviewer: intentional patterns, where bugs hide
  MEMORY.md      # accepted "intentional" decisions, one line each
  agents/        # declared agents, one Markdown file each
```

## Agent file

YAML front matter plus instructions. `@/path#Heading` imports one section of a file, read from the base commit. Front matter overrides `review.yml` for that agent.

```markdown
---
title: Auth and ownership
kind: bug                 # bug: validated, own thread | nit: batched, never blocking
when:
  paths: ['packages/auth/**', 'src/**/*.guard.ts']
  exclude: ['**/*.spec.ts']
  labels: []              # optional: any of
  authors: []             # optional
  targets: []             # optional: base branches
  triage: 'changes who can read or write which data, sessions, tokens or roles'
model: gpt-6.1-sol
effort: high
input: incremental        # incremental | full_diff | metadata
needs: []                 # check names that must pass first
max_findings: 8
---
Trace every changed handler to the check that proves the caller owns the row.
@/docs/auth.md#Rules
```

`when.triage` is the sentence the router reads to decide whether to add this agent when no path matched.

Selection rules: every non-empty `when` list must match. `labels` needs any one of the pull request's labels, `authors` the author, `targets` the base branch, and `paths` at least one changed file that no `exclude` pattern matches; a renamed file matches at its old or new path. An agent without `paths` covers every changed file. Only an agent that failed on `paths` alone, and has a `triage` line, is offered to the router. Patterns are globs; a pattern without a `/` matches the file name in any directory.

Import lines stand alone on their line. `@/path` imports the whole file and `@/path#Heading` the section from that heading to the next heading of the same or a higher level. A missing file or heading fails the run.

## `review.yml`

Every key has a default in the engine preset. Unknown keys fail the run and name the key.

```yaml
extends: mng:default

features:                        # always | manual | off
  reviewer: always
  agents: always
  verdict: always

depth: auto                      # auto | quick | balanced | deep; auto = router's risk level
risk_paths: []                   # changes here are deep, unless the change is mechanical

comments:
  min_severity: medium           # bugs below this go to the summary only
  max_nits: 5                    # inline nits per run; the rest in the summary
  summary: true

limits:
  max_runs_per_pr: 6
  max_file_kb: 300
  tokens_per_run: 1500000         # hard cap of one run
  tokens_by_depth: {quick: 100000, balanced: 300000, deep: 800000}   # what a run plans to spend
  tokens_per_pr: 5000000
  concurrency: 4

skip:
  drafts: true
  forks: true
  authors: ['dependabot[bot]', 'renovate[bot]']
  labels: [skip-review]
  targets: []
  paths: []
labels:
  always_review: [review]
  depth: {quick: mng-review-quick, deep: mng-review-deep}

disputes:
  accept_intentional_up_to: medium
  max_rounds: 1
verdict:
  blocking_severity: medium
  mode: preview                  # preview | approve
  never_approve: []

models:
  router:    {model: gpt-6-luna, effort: low}
  reviewer:                      # first finds, second validates; all find when risky
    - {model: gpt-6.1-sol, effort: high}
    - {model: claude-opus-5-5, effort: high}
  agents:    {model: gpt-6.1-sol, effort: high}   # a declared agent may override model and effort
  validator: cross               # or an explicit {model, effort}
```

## Pipeline

1. **Gate.** Apply `skip` and `features`. Wait for the checks an agent lists in `needs`. The same head, merge-base and config hash as the last run reuses the verdict.
2. **Route.** Paths, labels, authors and target branch select agents. The router model then reads the path list, a truncated diff and the `when.triage` line of each agent that failed on `paths` alone. It returns agents to add, one reason each, and a risk level: `trivial`, `normal` or `risky`. It can add agents and never removes one. A change under `risk_paths` is `risky`, unless the change is mechanical: at least 50 reviewable files, at least 60% of them small edits (at most 10 changed lines), added and removed lines within 25% of each other, and every file under `risk_paths` a small edit. A lint or format migration fits; it is at most `normal` whatever the router says, and the plan says why. If the router fails, the run continues with path selection and `normal`.
3. **Depth.** `trivial`: metadata agents only. `normal`: the first reviewer model runs the main reviewer, and selected agents run once. `risky`: every reviewer model runs the main reviewer on its own, each as one sub-agent per changed unit (function, handler, migration; up to 8 in parallel, fewer when the budget below pays for fewer). When `risk_paths` made the run deep, reviewer models after the first review only the units under those paths.

   **Token budget.** A run plans to spend `limits.tokens_by_depth` for its depth, never more than `limits.tokens_per_run`. 70% goes to the finders, split by weight: the main reviewer 4, a bug agent 2, a nit agent 1, its share split evenly over its units; the rest goes to validation, shared by the bug findings (30k to 60k each, so many findings can take a run past its plan). Each conversation re-sends its first message on every call, so the first message takes about a quarter of the conversation's share, and the diff is budgeted to fit. A conversation answers with what it has once it could not afford two more calls (each costs at least the input of the one before; before the first call the first message's length is the estimate), so a first message that takes more than half the share is answered in one call; and every finder answers once the finders' 70% is spent. So a run costs about its planned tokens whatever the number of agents; more agents get smaller shares.
4. **Find.** Each reviewer is a tool loop over chat completions. Tools are read-only and confined to the repository: `read_file(ref, path, range)`, `grep(ref, pattern, glob)`, `list_dir(ref, path)`, `diff(path?)`, `blame(path, range)`, `pr_metadata()`. Head content is read with `git show`; nothing from the change is built or executed. Change text and tool output are passed as fenced data. A finder's first message lists every changed file with its line counts, skipped files and their reason included, and carries the diff budgeted across files rather than cut in path order: from the smallest file diff up, a file that fits an even share of what is left is shown whole and a larger one is cut to that share; once the share is too small to be useful, files are shown whole while they fit, and what is left goes to the rest as excerpts of at least 600 characters, smallest first. The file list marks every cut or left-out file, and the message tells the agent to read those with `diff(path)` before it answers; a long diff comes back in parts, each ending with the offset of the next. Output: findings as JSON `{path, line, severity, title, trigger, impact, evidence[], suggestion?}`. Findings with the same root cause merge and record every model and agent that reported them: same kind and path, and the same fingerprint, or lines at most 6 apart with similar titles, or lines at most 6 apart from different finders whose title, trigger and impact share at least half of the shorter description's words and whose titles and impacts share at least 40%, so a common trigger alone never merges two failures. A report that matches several merged findings joins them all unless one finder would then hold two distinct reports. A model that answers 429, 503 or "unknown model" is dropped for the rest of the run; the run goes on with the remaining models and reports the drop. With no reviewer model left the run fails. Finders answer within the token budget described under Depth; no model call starts once `limits.tokens_per_run` is spent. A finder or unit stopped before it answered, and a validation that could not run, are named in the report, which is marked incomplete; every finding already produced is kept (an agent's `max_findings` still applies), and a finding whose validation did not run is kept as unvalidated.
5. **Validate.** One fresh agent per bug finding, instructed to refute it. With `validator: cross` it runs on a reviewer model that did not report the finding; a finding every reviewer model reported, or a run with a single reviewer model, is validated once by a reviewer model in a fresh context. An explicit `validator: {model, effort}` validates everything. It receives the finding, 150 lines either side of it at head, the diff, `CONTEXT.md`, `MEMORY.md` and earlier threads on that file. It answers confirm, reject or unverified, a re-rated severity and `path:line` evidence. It rejects speculation without a trigger in this repository, a wrong premise about this repository's code, claims that rest on unlikely or undocumented behaviour of a dependency, repeats of open threads and anything `MEMORY.md` covers. `unverified` is for a finding whose premises about the repository hold but which rests on a dependency's documented behaviour that the repository cannot show; the answer names that behaviour as `premise`. Type declarations, `package.json` versions and lockfile entries in the repository count as evidence. An unverified finding is kept at the validator's severity, reported after the confirmed ones and only in the summary, and never blocks (ADR 0005). A finding the validator cannot answer for after two attempts is kept.
6. **Publish.** Bugs at or above `comments.min_severity` get one inline thread each, with a hidden JSON block (`id`, `agent`, `severity`, `fingerprint`). Nits go into one review per run, capped by `comments.max_nits`. A sticky summary comment lists the agents that ran, the ones skipped and why, the router's additions, the risk level, findings by severity, rejected findings and tokens per model. Each agent gets a check run; the commit status `MNG Review` counts open bug threads.
7. **Converse.** A reply in one of the bot's threads starts a run for that thread. Fixed: resolve with the commit. "Intentional" with a reason the code confirms, at or below `disputes.accept_intentional_up_to`: resolve and record a memory candidate. Reason does not hold: one reply naming the failed premise. Above the limit, or a second disagreement: label `needs-owner`. On every push the bot re-checks its open threads whose file changed.
8. **Learn.** Accepted decisions are proposed for `.mng/MEMORY.md` in a periodic pull request. A periodic report lists findings, fixes, dismissals and tokens per agent.

## Running it

- **CLI:** `mng-review --base <ref>` reviews the current branch and prints findings as text or JSON (`--json`). `mng-review plan --base <ref>` prints which agents would run, which are skipped and why, the router's additions and the risk level, without a review. Locally, `.mng/` is read from the working tree; `--rules-ref <ref>` reads it from a commit instead, as CI does. `mng-review init` writes a starter `.mng/`; `--from-macroscope` builds it from `.macroscope/` (see Init). `mng-review bench <file>` replays recorded changes against expected findings (see Benchmark).
- **Endpoint:** `MNG_REVIEW_LLM_URL` and `MNG_REVIEW_LLM_KEY`. Nothing else about the provider is assumed.
- **CI:** a reusable workflow, `.github/workflows/review.yml`; the caller keeps its triggers and concurrency and passes the endpoint and key as secrets. Rules are read from the base commit, so a pull request cannot change the rules it is judged by. Fork pull requests are skipped. See CI in shadow mode.
- **Commands** in a pull request comment, from the repository owner: `/mng-review`, `/mng-review deep`, `/mng-review <agent>`.

## Init

`mng-review init` writes `review.yml` (extends `mng:default`), `CONTEXT.md` with the headings `Intentional patterns, not bugs` and `Where real bugs tend to hide`, an empty `MEMORY.md`, and two example agents, one `kind: bug` and one `kind: nit`. It refuses an existing `.mng/`; `--force` writes over the files it creates and leaves the others. Before anything is written, every generated `review.yml` and agent file is loaded as a review would load it, imports included, and a symlink on the way to any file it writes fails the command.

`mng-review init --from-macroscope` reads `.macroscope/` and leaves it untouched:

| Macroscope | `.mng/` |
|---|---|
| `correctness/correctness.md` body | `CONTEXT.md` (the starter when missing or empty) |
| its `exclude` | `skip.paths` |
| its `requires` | `needs` of every generated agent |
| `check-run-agents/<name>.md` | `agents/<name>.md`, body and `@/path` imports as they are |
| `title` | `title` |
| `include`, `exclude`, `labels`, `authors`, `targets` | `when.paths`, `when.exclude`, `when.labels`, `when.authors`, `when.targets` |
| `input: pr_metadata`, `incremental`, `full_diff` | `metadata`, `incremental`, `full_diff` |
| `input: code_object` | `full_diff`, with a warning |
| `requires` | `needs` |
| `model`, `reasoning` | dropped; the agent runs on `models.agents` |
| `maxRuns`, `maxBudget*` | dropped; `limits` cap runs and tokens |
| `approvability.md` `neverApprove` | `risk_paths` |
| its `alwaysApprove` | `skip.paths` for documentation globs only (no `!` globs); the rest is reported |
| its body | not imported |

Each agent gets `kind: nit` when its title or body mentions conventions, style or hygiene, otherwise `kind: bug`. A file name becomes lowercase with dashes for other characters; a name that is still invalid, names a built-in role or is taken gets a suffix. Line ends become LF. The output lists every dropped, changed or guessed field at the end. Exit codes: 0 when written, 2 when nothing is written.

## Benchmark

`mng-review bench <file>` replays recorded changes and compares the kept bug findings with the findings a case expects. It measures; it never passes or fails a run on the scores.

### File format, version 1

```yaml
version: 1
cases:
  - id: checkout-timeout          # unique in the file
    base: <commit sha>            # merge base of the change
    head: <commit sha>            # commit to review
    labels: []                    # optional pull request labels to simulate
    expected:
      - id: duplicate-charge      # unique within the case
        path: src/payments/charge.handler.ts
        line: 81
        label: real               # real | intentional | false
        summary: one sentence
```

`real` is a bug the change has. `intentional` is code that looks wrong but is deliberate, and `false` a known false alarm; a finding on either counts as noise. A bare `label: false` is read as the label `false`, though YAML parses it as a boolean. Unknown keys, a missing key, a `line` below 1 and duplicate ids fail the run and name the key.

### Run

Rules come from the working tree's `.mng/`, or from `--rules-ref <ref>`, as for a review. Each case is planned and reviewed like `mng-review --base <base> --head <head>` with the case's labels, read from git by its two commits; nothing is checked out and nothing from the change runs. Each case has its own token budget and model health.

A kept bug finding matches an expected entry of its case when the paths are equal and the lines differ by at most `--line-window` (default 20). An entry matches at most one finding and a finding at most one entry; the closest pairs match first, ties go to the earlier entry. Nits are counted apart and never match.

| Per case | Meaning |
|---|---|
| real found | `real` entries a finding matched |
| real missed | `real` entries no finding matched |
| noise | `intentional` or `false` entries a finding matched |
| unmatched | findings that matched no entry |
| nits | kept nits |
| tokens | per model, router included |
| wall time | plan and review |

The totals sum every case and add recall (found over all `real` entries) and unmatched findings per case. `--json` prints the same report as JSON. `--case <id>` (repeatable) runs a subset; an unknown id fails. `--concurrency <n>` reviews `n` cases at once, default 1.

Exit codes: 0 when every case ran, 2 on a configuration error (bench file, `.mng/`, an unknown commit) or when a case failed at the endpoint. With an endpoint failure the report is still printed.

## CI in shadow mode

The caller runs the reusable workflow on `pull_request_target` and passes `llm-url` and `llm-key` as secrets. Inputs: `runner` (default `ubuntu-latest`), `tailscale` (default `false`), `tailscale-tags` (default `tag:ci`) and `timeout-minutes` (default 20); with `tailscale` the job joins a tailnet as an ephemeral node with the `tailscale-oauth-client-id` and `tailscale-oauth-secret` secrets. The job has `contents: read` and `pull-requests: read`.

The job checks out the caller's base commit with its history, fetches the head commit's objects, checks out MNG Review at the workflow's own commit into a separate directory and installs it without running install scripts. It never checks out the head and never installs, builds or runs anything from the caller's repository. A fork's pull request does not start the job. The entry then:

1. reads the event (`GITHUB_EVENT_PATH`): base and head commits, labels, author, draft and fork flags, title and body; any other event is skipped;
2. skips a fork's pull request, loads `.mng/` from the base commit and applies `skip` (a draft is skipped unless `skip.drafts` is off or a `labels.always_review` label is set); `features` apply in the plan with the trigger `auto`;
3. probes the endpoint with `GET /models` and a 10-second timeout; unreachable, timed out, 401, 403, 429, 5xx or an unset URL end the run as "reviewer offline: <reason>" with exit 0; any other answer, such as a 404 from an endpoint without `/models`, goes on;
4. reviews base..head as `mng-review --base <base> --head <head> --rules-ref <base>` does, with title, body and labels passed to the models as fenced data;
5. writes the job summary: the verdict it would post, the risk level, the agents that ran and why, the agents skipped and why, bugs by severity with path and line (confirmed and unvalidated first, then unverified), nits, findings the validator rejected (collapsed), agents and units that did not finish, tokens per model, wall time and the engine commit. Every text from a model or the repository is escaped.

It posts nothing: no comment, review, check run or status. Exit codes: 0 for any review result, a skip or an offline endpoint; 2 when `.mng/` at the base commit or the event is invalid, with the file and key in the summary; 1 when git cannot read the change. The endpoint URL and key are registered with `::add-mask::` and never printed. ADR 0006 records the trigger and this contract.

## Stages

1. Engine, local: config and agent schema, routing and risk, main reviewer, declared agents, validator, CLI output.
2. Rules and benchmark: `init`, `bench`, a starter preset.
3. CI in shadow mode: reusable workflow, findings in the job summary only (see CI in shadow mode).
4. Publish and converse: threads, nit batch, summary with verdict, status, thread re-check, author replies, commands.
5. Memory and report.
