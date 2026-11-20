# MNG Review

Pull request review by agents you declare in your repository.

A built-in main reviewer hunts for bugs on every code change. Agents you write as Markdown files in `.mng/agents/` cover what is specific to your codebase (auth, migrations, billing, conventions) and run only when a change touches their area. A second agent tries to refute every finding before it is posted. The same review runs from the command line before you push and from a GitHub workflow on the pull request.

It talks to any OpenAI-compatible chat completions endpoint. You bring the endpoint and the key.

## Status

Under construction. The CLI works locally; the GitHub workflow runs in shadow mode, writing its findings to the job summary, or in publish mode, commenting on the pull request. The design is in [docs/spec.md](docs/spec.md); progress is tracked in the issues.

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

### GitHub Actions

The reusable workflow `.github/workflows/review.yml` reviews a pull request and writes the result to the job summary. In this stage it posts nothing on the pull request and never fails the job because of findings. Add a caller workflow to your repository and store the endpoint as two repository secrets:

```yaml
# .github/workflows/mng-review.yml
name: MNG Review

on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

# One run per pull request; a new push cancels the run before it.
concurrency:
  group: mng-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    # Pin a full commit SHA of this repository.
    uses: Mnigos/mng-review/.github/workflows/review.yml@<commit-sha>
    permissions:
      contents: read
      pull-requests: read
    secrets:
      llm-url: ${{ secrets.MNG_REVIEW_LLM_URL }}
      llm-key: ${{ secrets.MNG_REVIEW_LLM_KEY }}
```

`pull_request_target` is safe here because the workflow and the `.mng/` rules come from the base branch and no code from the pull request is executed: the job checks out the base commit, reads the head commit with `git show` and runs only this repository's engine. It becomes unsafe if you add a step that checks out the head, installs dependencies, builds or runs scripts from the pull request, or interpolates its title, body or branch name into a shell command.

| Input             | Default         | Meaning                                                         |
| ----------------- | --------------- | --------------------------------------------------------------- |
| `runner`          | `ubuntu-latest` | Runner label for the job                                        |
| `tailscale`       | `false`         | Join a tailnet as an ephemeral node to reach a private endpoint |
| `tailscale-tags`  | `tag:ci`        | Tags for that node; the OAuth client must own them              |
| `timeout-minutes` | `20`            | Job timeout                                                     |

Secrets: `llm-url` and `llm-key` (required), `tailscale-oauth-client-id` and `tailscale-oauth-secret` (with `tailscale: true`). For an endpoint on a tailnet, add under the job:

```yaml
with:
  tailscale: true
  tailscale-tags: tag:ci-review
secrets:
  llm-url: ${{ secrets.MNG_REVIEW_LLM_URL }}
  llm-key: ${{ secrets.MNG_REVIEW_LLM_KEY }}
  tailscale-oauth-client-id: ${{ secrets.TS_OAUTH_CLIENT_ID }}
  tailscale-oauth-secret: ${{ secrets.TS_OAUTH_SECRET }}
```

The node joins with `--shields-up` and then turns subnet routes off (`tailscale set --accept-routes=false`), so it takes no subnet routes and accepts no connections: the endpoint must be a tailnet node, addressed by its tailnet address or MagicDNS name, not a host behind a subnet router. Give its tag an access rule that reaches the endpoint's host and port and nothing else, for example `{"action": "accept", "src": ["tag:ci-review"], "dst": ["<endpoint-host>:443"]}` in the `acls` of your policy, and use an OAuth client with only the `auth_keys` scope and that one tag. Pull requests from forks are skipped. Drafts follow `skip.drafts`. When the endpoint does not answer `GET /models` within 10 seconds, refuses the key, rate limits or fails, the summary says "reviewer offline" and the job passes. An invalid `.mng/` at the base commit fails the job with exit code 2 and names the file and key. ADR 0006 records the trigger and this contract.

The job also uploads the result as JSON, the artifact `mng-review-result`, kept 14 days: status, pull request number and commits, verdict, wall time, tokens per model and the document `mng-review --json` prints. Fetch it with `gh run download <run-id> --name mng-review-result`.

On a public repository anyone can read the job summary and download the artifact, findings included, before the pull request merges. With `pull_request_target`, use a self-hosted `runner` only if it is ephemeral, since the job holds the endpoint key.

### Publish mode

`review-publish.yml` also comments on the pull request as `github-actions[bot]`: one thread per bug with its evidence, unverified findings marked as such, nits in the same review, and a summary comment with the verdict that is edited on every run. A finding already in an open thread is not posted twice. The bot only comments; it never approves or requests changes. It takes the same inputs and secrets as `review.yml`; grant the job `pull-requests`, `checks` and `statuses` write:

```yaml
jobs:
  review:
    uses: Mnigos/mng-review/.github/workflows/review-publish.yml@<commit-sha>
    permissions:
      contents: read
      pull-requests: write
      checks: write
      statuses: write
    secrets:
      llm-url: ${{ secrets.MNG_REVIEW_LLM_URL }}
      llm-key: ${{ secrets.MNG_REVIEW_LLM_KEY }}
```

Each run shows two jobs. `MNG Review (review)` holds the endpoint secrets and a read-only token and makes every model call; `MNG Review (publish)` holds the write token and posts what the review job left in the `mng-review-outcome` artifact, which is kept for a day. The caller's YAML above stays the same. To run a review again, re-run all jobs: re-running the publish job alone posts nothing and says so.

`review.yml` never gets write access, whatever the caller grants. On every run the bot checks its open threads again whose file changed and replies in the ones the validator no longer finds, which closes them for the bot (GitHub lets the job token resolve a thread only with `contents: write`, which the workflow does not ask for, so you resolve it on GitHub), writes a check run per agent, and sets the commit status `MNG Review`: `failure` while bug threads of the bot are open, `success` when none are, `error` when the run did not finish. Require that status in branch protection to gate merges on it. After `limits.max_runs_per_pr` runs, pushes are no longer reviewed. Declared agents with `input: incremental` review only what changed since the last finished run; the main reviewer always sees the whole change. ADRs 0007 and 0008 record the rules.

To count threads resolved by hand without waiting for the next push, run the status sweep on a schedule. It runs no model and needs no endpoint secret:

```yaml
# .github/workflows/mng-review-sweep.yml
name: MNG Review status sweep

on:
  schedule:
    - cron: '*/15 * * * *'

permissions:
  contents: read

jobs:
  sweep:
    uses: Mnigos/mng-review/.github/workflows/status-sweep.yml@<commit-sha>
    permissions:
      contents: read
      pull-requests: read
      statuses: write
```

### Posting as a GitHub App

By default the bot is `github-actions[bot]`. To post threads, replies, the summary, check runs and the status as your own app instead:

1. Create a GitHub App with no webhook and no events. Give it read and write on pull requests, checks and commit statuses, and read on contents and metadata. Contents read is needed because the bot reads its review threads through GraphQL, which names each comment's commit; it never writes contents.
2. Install it on the repositories that run the review, choosing them one by one.
3. Store its client id and a private key as the repository secrets `MNG_REVIEW_APP_CLIENT_ID` and `MNG_REVIEW_APP_PRIVATE_KEY`.
4. Reserve the user login that matches the app's slug, for example by creating an empty organization with that name. A mention of the handle then can never reach someone else's account, and a mention of an organization notifies nobody.

Then pass the slug and the two secrets to both callers:

```yaml
jobs:
  review:
    uses: Mnigos/mng-review/.github/workflows/review-publish.yml@<commit-sha>
    permissions:
      contents: read
      pull-requests: write
      checks: write
      statuses: write
    with:
      app-slug: your-app-slug
    secrets:
      llm-url: ${{ secrets.MNG_REVIEW_LLM_URL }}
      llm-key: ${{ secrets.MNG_REVIEW_LLM_KEY }}
      app-client-id: ${{ secrets.MNG_REVIEW_APP_CLIENT_ID }}
      app-private-key: ${{ secrets.MNG_REVIEW_APP_PRIVATE_KEY }}
```

```yaml
jobs:
  sweep:
    uses: Mnigos/mng-review/.github/workflows/status-sweep.yml@<commit-sha>
    permissions:
      contents: read
      pull-requests: read
      statuses: write
    with:
      app-slug: your-app-slug
    secrets:
      app-client-id: ${{ secrets.MNG_REVIEW_APP_CLIENT_ID }}
      app-private-key: ${{ secrets.MNG_REVIEW_APP_PRIVATE_KEY }}
```

Without `app-slug` and the two secrets the callers work as above. Setting only some of the three fails before anything is written: in `review-publish.yml` the publish job fails, after the review job has already called the model, and in `status-sweep.yml` the sweep job fails. Only the publish and sweep jobs read the key, and each mints a token for the calling repository with the permissions it needs, which GitHub revokes when the job ends. The review job, which calls the model, never holds the key.

Switching keeps one set of threads and one visible summary. The app answers in the threads `github-actions[bot]` opened, carries the run count over into a new summary and hides the old one, or deletes it when GitHub refuses to hide it. `identity.previous` in `.mng/review.yml` lists the bots whose earlier comments still count; it defaults to `[github-actions]`, and a repository that goes back to the job token sets it to `[your-app-slug]`.

Before you switch:

- A required `MNG Review` check bound to GitHub Actions blocks every pull request once the app sets the status. Set its source to any source before the switch and to the app after it.
- Comments, statuses and check runs the app makes start the repository's other workflows, which writes with `GITHUB_TOKEN` never did. Check workflows that listen to `issue_comment`, `pull_request_review`, `pull_request_review_comment`, `status`, `check_run` or `check_suite`.
- Set `identity.previous: []` once the pull requests opened before the switch are closed. On a pull request that is still open, the bot then posts the findings of the old threads again, and an old summary stays visible next to the new one.
- Pass the two app secrets by name as above. Never use `secrets: inherit`: it exposes every secret of the repository to the reusable workflow, and the names `MNG_REVIEW_APP_CLIENT_ID` and `MNG_REVIEW_APP_PRIVATE_KEY` do not map to its inputs `app-client-id` and `app-private-key`.

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
