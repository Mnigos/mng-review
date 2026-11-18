# MNG Review

Pull request review by agents you declare in your repository.

A built-in main reviewer hunts for bugs on every code change. Agents you write as Markdown files in `.mng/agents/` cover what is specific to your codebase (auth, migrations, billing, conventions) and run only when a change touches their area. A second agent tries to refute every finding before it is posted. The same review runs from the command line before you push and from a GitHub workflow on the pull request.

It talks to any OpenAI-compatible chat completions endpoint. You bring the endpoint and the key.

## Status

Under construction. The CLI works locally; the GitHub workflow comes later. The design is in [docs/spec.md](docs/spec.md); progress is tracked in the issues.

## Usage

### Install from source

The package is not on npm yet. You need Bun 1.4.2 or newer.

```sh
git clone https://github.com/Mnigos/mng-review.git
cd mng-review
bun install --frozen-lockfile
alias mng-review="bun $PWD/apps/cli/src/main.ts"
```

Run the commands below from inside the repository you want reviewed.

### Endpoint

Every model call goes to one OpenAI-compatible chat completions endpoint:

```sh
export MNG_REVIEW_LLM_URL=https://llm.example.com/v1   # base URL, required for a review
export MNG_REVIEW_LLM_KEY=...                          # optional, sent as a bearer token
```

Models and effort per role are set under `models` in `.mng/review.yml`.

### Set up `.mng/`

```sh
mng-review init
```

writes a starter `.mng/`: `review.yml` extending `mng:default`, `CONTEXT.md` with the two sections the main reviewer reads, an empty `MEMORY.md` and two example agents, one `kind: bug` and one `kind: nit`. Edit them, then commit them.

```sh
mng-review init --from-macroscope
```

builds `.mng/` from an existing `.macroscope/` folder instead and leaves that folder as it is. The correctness context becomes `CONTEXT.md`, check-run agents become agents, `neverApprove` becomes `risk_paths` and documentation globs of `alwaysApprove` become `skip.paths`. The output ends with every field it dropped, changed or guessed, including the `kind` it chose for each agent.

Both refuse to touch an existing `.mng/`; `--force` writes over the files `init` creates and leaves the others.

### See the plan

```sh
mng-review plan --base main
```

prints which agents would run, which are skipped and why, the router's additions and the risk level, without a review. `--no-router` skips the router model and uses the path rules only.

### Review

```sh
mng-review --base main
```

reviews the commits between the merge base with `main` and `HEAD` and prints the findings. Useful flags:

| Flag                                    | Meaning                                                            |
| --------------------------------------- | ------------------------------------------------------------------ |
| `--head <ref>`                          | Review another commit than `HEAD`                                  |
| `--rules-ref <ref>`                     | Read `.mng/` from a commit instead of the working tree, as CI does |
| `--label <name>`                        | A pull request label to simulate; repeat for more                  |
| `--author <login>`, `--target <branch>` | The pull request author and base branch                            |
| `--title <text>`, `--body <text>`       | The pull request title and description, shown to the reviewers     |
| `--json`                                | Print JSON instead of text                                         |

`plan` takes the same flags apart from `--title` and `--body`.

### Benchmark

```sh
mng-review bench bench.yml
```

replays the recorded changes in `bench.yml` and compares the findings with the expected ones: real bugs found and missed, noise, unmatched findings, nits, tokens per model and wall time per case, then totals with recall. The file format is in [docs/spec.md](docs/spec.md#benchmark). `--case <id>` runs a subset, `--line-window <n>` sets how far a finding may be from the expected line (default 20), `--concurrency <n>` reviews several cases at once, `--json` prints JSON. It exits 0 when every case ran, whatever the scores.

### Exit codes

| Code | `mng-review`                                              | `plan`, `init`                                                                 |
| ---- | --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 0    | No bug at or above `comments.min_severity`                | Done                                                                           |
| 1    | At least one such bug survived validation                 | Not used                                                                       |
| 2    | Configuration error, missing endpoint or endpoint failure | Configuration error; for `init`, also an existing `.mng/` or nothing to import |

## Development

A Bun workspace on Effect 4: `packages/domain` (schemas and pure logic), `packages/engine` (services) and `apps/cli` (the `mng-review` binary). [CONTRIBUTING.md](CONTRIBUTING.md) lists the commands; [ARCHITECTURE.md](ARCHITECTURE.md) maps the code.

## License

MIT
