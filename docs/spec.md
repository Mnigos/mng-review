# MNG Review: specification

Pull request review by one built-in reviewer and the agents a repository declares. The engine is a Bun + TypeScript package (`@mnigos/mng-review`, binary `mng-review`) used three ways: a CLI, a reusable GitHub workflow and a library. It talks to any OpenAI-compatible chat completions endpoint.

## Roles

The conductor is code. Models do five jobs:

| Role | Defined by | Job |
|---|---|---|
| Router | engine | adds agents the path rules missed and rates the risk of the change |
| Main reviewer | engine, steered by `.mng/CONTEXT.md` | finds bugs across files; runs on every code change |
| Declared agents | `.mng/agents/*.md` | `kind: bug` specialists and `kind: nit` convention checks |
| Validator | engine | tries to refute each bug finding before it is posted |
| Verdict | engine | `ready`, `needs fixes` or `needs owner` |

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
risk_paths: []                   # changes here are always deep

comments:
  min_severity: medium           # bugs below this go to the summary only
  max_nits: 5                    # inline nits per run; the rest in the summary
  summary: true

limits:
  max_runs_per_pr: 6
  max_file_kb: 300
  tokens_per_run: 1500000
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
  router:    {model: gpt-6-luna,    effort: low}
  reviewer:  {model: gpt-6.1-sol,   effort: medium}
  nits:      {model: gpt-6.1-terra, effort: medium}
  validator: {model: gpt-6.1-sol,   effort: high}
  fallback:  null
```

## Pipeline

1. **Gate.** Apply `skip` and `features`. Wait for the checks an agent lists in `needs`. The same head, merge-base and config hash as the last run reuses the verdict.
2. **Route.** Paths, labels, authors and target branch select agents. The router model then reads the path list, a truncated diff and each unselected agent's `when.triage` line. It returns agents to add, one reason each, and a risk level: `trivial`, `normal` or `risky`. It can add agents and never removes one. A change under `risk_paths` is `risky`. If the router fails, the run continues with path selection and `normal`.
3. **Depth.** `trivial`: metadata agents only. `normal`: main reviewer and selected agents once. `risky`: the main reviewer runs one sub-agent per changed unit (function, handler, migration; up to 8 in parallel) at higher effort.
4. **Find.** Each reviewer is a tool loop over chat completions. Tools are read-only and confined to the repository: `read_file(ref, path, range)`, `grep(ref, pattern, glob)`, `list_dir(ref, path)`, `diff(path?)`, `blame(path, range)`, `pr_metadata()`. Head content is read with `git show`; nothing from the change is built or executed. Change text and tool output are passed as fenced data. Output: findings as JSON `{path, line, severity, title, trigger, impact, evidence[], suggestion?}`.
5. **Validate.** One fresh agent per bug finding, instructed to refute it. It receives the finding, the file, the diff, `CONTEXT.md`, `MEMORY.md` and earlier threads on that file. It answers confirm or reject, a re-rated severity and `path:line` evidence. It rejects speculation without a trigger in this repository, claims that rest on behaviour the repository does not show, repeats of open threads and anything `MEMORY.md` covers. Findings with the same root cause merge. A finding the validator cannot answer for after two attempts is kept.
6. **Publish.** Bugs at or above `comments.min_severity` get one inline thread each, with a hidden JSON block (`id`, `agent`, `severity`, `fingerprint`). Nits go into one review per run, capped by `comments.max_nits`. A sticky summary comment lists the agents that ran, the ones skipped and why, the router's additions, the risk level, findings by severity, rejected findings and tokens per model. Each agent gets a check run; the commit status `MNG Review` counts open bug threads.
7. **Converse.** A reply in one of the bot's threads starts a run for that thread. Fixed: resolve with the commit. "Intentional" with a reason the code confirms, at or below `disputes.accept_intentional_up_to`: resolve and record a memory candidate. Reason does not hold: one reply naming the failed premise. Above the limit, or a second disagreement: label `needs-owner`. On every push the bot re-checks its open threads whose file changed.
8. **Learn.** Accepted decisions are proposed for `.mng/MEMORY.md` in a periodic pull request. A periodic report lists findings, fixes, dismissals and tokens per agent.

## Running it

- **CLI:** `mng-review --base <ref>` reviews the current branch and prints findings as text or JSON (`--json`). `mng-review plan --base <ref>` prints which agents would run, which are skipped and why, the router's additions and the risk level, without a review. Locally, `.mng/` is read from the working tree; `--rules-ref <ref>` reads it from a commit instead, as CI does. `mng-review init` writes a starter `.mng/`. `mng-review bench <file>` replays recorded changes against expected findings.
- **Endpoint:** `MNG_REVIEW_LLM_URL` and `MNG_REVIEW_LLM_KEY`. Nothing else about the provider is assumed.
- **CI:** a reusable workflow; the caller keeps its triggers and concurrency and passes the endpoint and key as secrets. Rules are read from the base commit, so a pull request cannot change the rules it is judged by. Fork pull requests are skipped.
- **Commands** in a pull request comment, from the repository owner: `/mng-review`, `/mng-review deep`, `/mng-review <agent>`.

## Stages

1. Engine, local: config and agent schema, routing and risk, main reviewer, declared agents, validator, CLI output.
2. Rules and benchmark: `init`, `bench`, a starter preset.
3. CI in shadow mode: reusable workflow, findings in the job summary only.
4. Publish and converse: threads, nit batch, summary with verdict, status, thread re-check, author replies, commands.
5. Memory and report.
