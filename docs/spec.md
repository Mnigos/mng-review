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
| Router | engine | adds agents the path rules missed and names what makes the change risky |
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
2. **Route.** Paths, labels, authors and target branch select agents. The router model then reads the path list, a truncated diff and the `when.triage` line of each agent that failed on `paths` alone. It returns agents to add, one reason each, and risk signals: each names a category, a changed file and the lines in it. The categories are `access` (the check that decides who is signed in or may read or change something), `money` (charges, refunds, prices, entitlements), `stored_data` (schemas, migrations, updates or deletes of existing records) and `secrets` (credentials, keys, and what personal data goes to logs or other services); code that only calls an existing check, reads data or renders it is not a signal. The engine drops a signal whose file is not a reviewable changed file and derives the risk level by rule: `risky` with at least one signal, else `trivial` when the router marked the change as having no runtime effect, else `normal`. The model reports what the change does; the threshold is code, so the same change gets the same depth. The path list it reads is sorted. It can add agents and never removes one. A change under `risk_paths` is `risky`, unless the change is mechanical: at least 50 reviewable files, at least 60% of them small edits (at most 10 changed lines), added and removed lines within 25% of each other, and no file under `risk_paths` rewritten (50 or more added plus removed lines; an edit to a risky file below that passes this condition, so when the others pass too the router's rating is capped at `normal`). A lint or format migration fits, the few dozen lines it often changes in configuration under `risk_paths` included; it is at most `normal` whatever the router says. When files under `risk_paths` changed, `plan` and the review output print the measured values against each limit and the conditions that failed, and the JSON carries them as `risk.shape`. If the router fails, the run continues with path selection and `normal`.
3. **Depth.** `trivial`: metadata agents only. `normal`: the first reviewer model runs the main reviewer, and selected agents run once. `risky`: every reviewer model runs the main reviewer on its own, each as one sub-agent per changed unit (function, handler, migration; up to 8 in parallel, fewer when the budget below pays for fewer; when there are more files than units, the files are taken in path order and each unit closes once it holds its even share of the changed lines, so a unit keeps neighbouring files together). When `risk_paths` made the run deep, reviewer models after the first review only the units under those paths; when the router's signals made it deep, only the units of the files the signals name. Such a narrowed reviewer model plans tokens for the lines it reviews: its share times the changed lines of those files over all changed lines, at least a quarter of its share.

   **Token budget.** A run plans to spend `limits.tokens_by_depth` for its depth, never more than `limits.tokens_per_run`. 70% goes to the finders, split by weight: the main reviewer 4, a bug agent 2, a nit agent 1, its share split evenly over its units; the main reviewer runs get at least 40% of it together, the agents splitting the rest by weight, so many selected agents do not leave the one cross-file finder a few calls; the rest goes to validation, shared by the bug findings (30k to 60k each, so many findings can take a run past its plan). A finder that answers under its share gives the rest to the run's pool, and a main reviewer conversation that would otherwise have to answer claims what it lacks from the pool first, so tokens an agent did not need go to the one cross-file finder instead of being left unspent. Each conversation re-sends its first message on every call, so the first message's diff takes at most 15% of the conversation's share, and the conversation reads the rest with tools. A conversation answers with what it has once it could not afford two more calls (each costs at least the input of the one before; before the first call the first message's length is the estimate), so a first message that takes more than half the share is answered in one call; and every finder answers once the finders' 70% is spent. So a run costs about its planned tokens whatever the number of agents; more agents get smaller shares.
4. **Find.** Each reviewer is a tool loop over chat completions. Tools are read-only and confined to the repository: `read_file(ref, path, range)`, `grep(ref, pattern, glob)`, `list_dir(ref, path)`, `diff(path?)`, `blame(path, range)`, `pr_metadata()`. Head content is read with `git show`; nothing from the change is built or executed. Change text and tool output are passed as fenced data. A finder's first message lists every changed file with its line counts, skipped files and their reason included, and carries the diff budgeted across files rather than cut in path order: from the smallest file diff up, a file that fits an even share of what is left is shown whole and a larger one is cut to that share; once the share is too small to be useful, files are shown whole while they fit, and what is left goes to the rest as excerpts of at least 600 characters, smallest first. The file list marks every cut or left-out file and names, for each of them, up to four functions or blocks its hunks change (the context git prints after `@@`), and the message tells the agent to read those with `diff(path)` before it answers; a long diff comes back in parts, each ending with the offset of the next. Output: findings as JSON `{path, line, severity, title, trigger, impact, evidence[], suggestion?}`. Findings with the same root cause merge and record every model and agent that reported them: same kind and path, and the same fingerprint, or lines at most 6 apart with similar titles, or lines at most 6 apart from different finders whose title, trigger and impact share at least half of the shorter description's words and whose titles and impacts share at least 40%, so a common trigger alone never merges two failures. A report that matches several merged findings joins them all unless one finder would then hold two distinct reports. The main reviewer's method is checked, not only asked for: before its answer counts it must have read every changed file in its scope with `read_file`, `diff` or `blame` (a finding on a file counts too, and so does a file whose whole diff its first message showed). A quarter of each such conversation's share is held back until then, so an answer the token budget forced still leaves room for the turn. When it answers with files unread and its tool calls, wall time and tokens allow another turn, it gets one continuation turn naming them (at most 20, the rest counted); its findings so far are kept, the continuation adds only findings that do not repeat them, and a continuation that fails keeps the first answer. The report counts the conversations that got one. A model that answers 429, 503 or "unknown model" is dropped for the rest of the run; the run goes on with the remaining models and reports the drop. With no reviewer model left the run fails. Finders answer within the token budget described under Depth; no model call starts once `limits.tokens_per_run` is spent. A finder or unit stopped before it answered, and a validation that could not run, are named in the report, which is marked incomplete; every finding already produced is kept (an agent's `max_findings` still applies), and a finding whose validation did not run is kept as unvalidated.
5. **Validate.** One fresh agent per bug finding, instructed to refute it. With `validator: cross` it runs on a reviewer model that did not report the finding; a finding every reviewer model reported, or a run with a single reviewer model, is validated once by a reviewer model in a fresh context. An explicit `validator: {model, effort}` validates everything. It receives the finding, 150 lines either side of it at head, the diff, `CONTEXT.md`, `MEMORY.md` and earlier threads on that file. It answers confirm, reject or unverified, a severity by the rubric (see Severity) and `path:line` evidence. It rejects only with lines of this repository that show the finding is wrong: a trigger that cannot happen here or none named, a wrong premise about this repository's code, a dependency behaviour that the repository's type declarations, manifests, lockfile, vendored code or tests contradict, repeats of open threads, anything `MEMORY.md` or `CONTEXT.md` covers, and style rather than behaviour. Its memory of a dependency is not evidence. `unverified` is for a finding whose premises about the repository hold but which rests on a dependency's behaviour the repository neither shows nor rules out; the answer names that behaviour as `premise`. The engine enforces two rules on every answer: a rejection whose evidence names no file at the head or the merge base and no rules file is kept as unverified at the reported severity, and a severity below the reported one without `lowered_because` is replaced by the reported one; both leave a note in the validation. An unverified finding is kept at the validator's severity, reported after the confirmed ones and only in the summary, and never blocks (ADR 0005). A finding the validator cannot answer for after two attempts is kept. Bugs the text match left apart but that sit on the same path at most 6 lines apart, from different finders, are validated as a group: the most severe is validated with the others listed as nearby findings, and its validator names in `same_root_cause` those that describe the same defect. They merge into it with every agent and model recorded and are not validated again; the rest of the group goes on the same way. A rejected or unvalidated finding merges nothing, and one finder's own reports are never offered as duplicates.
6. **Publish.** Bugs at or above `comments.min_severity` get one inline thread each, with a hidden JSON block (`id`, `agent`, `severity`, `fingerprint`). Nits go into one review per run, capped by `comments.max_nits`. A sticky summary comment lists the agents that ran, the ones skipped and why, the router's additions, the risk level, findings by severity, rejected findings and tokens per model. Each agent gets a check run; the commit status `MNG Review` counts open bug threads.
7. **Converse.** A reply in one of the bot's threads starts a run for that thread. Fixed: resolve with the commit. "Intentional" with a reason the code confirms, at or below `disputes.accept_intentional_up_to`: resolve and record a memory candidate. Reason does not hold: one reply naming the failed premise. Above the limit, or a second disagreement: label `needs-owner`. On every push the bot re-checks its open threads whose file changed.
8. **Learn.** Accepted decisions are proposed for `.mng/MEMORY.md` in a periodic pull request. A periodic report lists findings, fixes, dismissals and tokens per agent.

## Severity

Finders rate a bug by what goes wrong when its trigger happens, and the validator re-rates it with the same rubric (`SEVERITY_CRITERIA` in `packages/domain`). The level is the highest one whose criterion the impact meets:

| Severity | Criterion |
|---|---|
| `critical` | data is lost or corrupted, or a security boundary fails: private data, credentials, money or access reach someone who should not have them |
| `high` | the program crashes, a request or a main flow fails, or users get wrong data, shown to them or stored |
| `medium` | behaviour a user can see is broken, but the user can recover: retry, reload, undo or take another path |
| `low` | cosmetic, or nothing a user can reach: only logs, metrics or developer tooling change |

How often the trigger happens does not change the level, and neither does how many users it reaches: a defect on one platform, browser, locale, user setting or assistive technology rates the same as one that hits everyone. A trigger that cannot happen is a reason to reject, not to lower. The validator starts from the reported severity and may raise it; it lowers it only by naming, in `lowered_because`, the reported level and the part of its criterion the impact does not meet. Nits are always `low`.

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
    title: Fix the checkout timeout  # optional pull request title the models see
    body: |                       # optional pull request description
      Retries the charge once.
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

A kept bug finding matches an expected entry of its case when the paths are equal and the lines differ by at most `--line-window` (default 20). An entry matches at most one finding and a finding at most one entry; the closest pairs match first, ties go to the earlier entry. A `real` entry left unmatched is a near match when an unmatched finding sits in another file of the same directory and its title, trigger and impact contain at least half of the entry summary's content words, the share at which two reports count as one problem when findings merge. A near match never counts as found. Nits are counted apart and never match.

| Per case | Meaning |
|---|---|
| real found | `real` entries a finding matched, with the finding's validation: confirmed, unverified or unvalidated |
| near | `real` entries with a near match in a sibling file |
| real missed | `real` entries no finding matched or sat near |
| noise | `intentional` or `false` entries a finding matched |
| unmatched | findings that matched no entry and sit near none |
| rejected | bugs the validator rejected, with its reason and model |
| depth | the depth the plan chose, the rule that chose it, and the risk |
| nits | kept nits |
| tokens | per model, router included |
| wall time | plan and review |

The totals sum every case, split found into confirmed and unverified, and add recall (found over all `real` entries, near ones included) and unmatched findings per case. `--json` prints the same report as JSON. `--case <id>` (repeatable) runs a subset; an unknown id fails. `--concurrency <n>` reviews `n` cases at once, default 1.

Exit codes: 0 when every case ran, 2 on a configuration error (bench file, `.mng/`, an unknown commit) or when a case failed at the endpoint. With an endpoint failure the report is still printed.

## CI in shadow mode

The caller runs the reusable workflow on `pull_request_target` and passes `llm-url` and `llm-key` as secrets. Inputs: `runner` (default `ubuntu-latest`), `tailscale` (default `false`), `tailscale-tags` (default `tag:ci`) and `timeout-minutes` (default 20); with `tailscale` the job joins a tailnet as an ephemeral node with the `tailscale-oauth-client-id` and `tailscale-oauth-secret` secrets. The job has `contents: read` and `pull-requests: read`.

Only a pull request from the caller's own repository starts the job. It checks out the caller's base commit with its history, fetches the head commit's objects, checks out MNG Review at the workflow's own commit into a separate directory and installs it without running install scripts. It never checks out the head and never installs, builds or runs anything from the caller's repository: Bun starts in MNG Review's directory with `--no-env-file`, and git reads the caller's checkout through `MNG_REVIEW_REPO_DIR`. A tailnet node joins with `--shields-up` and then turns subnet routes off (`tailscale set --accept-routes=false`). The entry then:

1. reads the event (`GITHUB_EVENT_PATH`): base and head commits, labels, author, draft and fork flags, title and body; any other event is skipped;
2. skips a fork's pull request, loads `.mng/` from the base commit and applies `skip` (a draft is skipped unless `skip.drafts` is off or a `labels.always_review` label is set); `features` apply in the plan with the trigger `auto`;
3. probes the endpoint with `GET /models` and a 10-second timeout; unreachable, timed out, 401, 403, 429, 5xx or an unset URL end the run as "reviewer offline: <reason>" with exit 0; any other answer, such as a 404 from an endpoint without `/models`, goes on;
4. reviews base..head as `mng-review --base <base> --head <head> --rules-ref <base>` does, with title, body and labels passed to the models as fenced data;
5. writes the job summary: the verdict it would post, the risk level, the agents that ran and why, the agents skipped and why, bugs by severity with path and line (confirmed and unvalidated first, then unverified), nits, findings the validator rejected (collapsed), agents and units that did not finish, tokens per model, wall time and the engine commit. Every text from a model or the repository is escaped, and URLs become code;
6. writes the result file, which the workflow uploads as the artifact `mng-review-result` (kept 14 days), also after an invalid configuration: `version`, `status`, `engineCommit`, `run` (repository, event name, run id and attempt), `pullRequest` (number, base and head commits, target branch, author, labels, draft; no title or body), `wallMillis` of the whole entry, `verdict`, `tokens` per model, `reason` and `source` for a run that did not review, and under `review` the document `mng-review --json` prints. Every masked endpoint value is replaced before the file is written. The job summary is not exposed through the API; the artifact is.

It posts nothing: no comment, review, check run or status. Exit codes: 0 for any review result, a skip or an offline endpoint; 2 when `.mng/` at the base commit or the event is invalid, with the file and key in the summary; 1 when git cannot read the change. The endpoint URL and key are registered with `::add-mask::` and never printed. ADR 0006 records the trigger and this contract.

## Stages

1. Engine, local: config and agent schema, routing and risk, main reviewer, declared agents, validator, CLI output.
2. Rules and benchmark: `init`, `bench`, a starter preset.
3. CI in shadow mode: reusable workflow, findings in the job summary only (see CI in shadow mode).
4. Publish and converse: threads, nit batch, summary with verdict, status, thread re-check, author replies, commands.
5. Memory and report.
