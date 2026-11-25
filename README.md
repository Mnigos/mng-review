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

`review-publish.yml` also reviews the pull request as `github-actions[bot]`: one review per run whose body is the summary with the verdict and whose comments are the new threads, one per bug with its evidence, unverified findings marked as such, and nits. A run that posts nothing new edits the body of the bot's last review instead, so it notifies no one, and each new review hides the bot's earlier ones as outdated. A finding already in an open thread is not posted twice. The review's state carries the verdict: it requests changes while a confirmed bug thread is open or a thread waits for the owner and comments otherwise; `github-actions[bot]` never approves (see below). A run that cannot tell, such as one whose head moved, one that reviewed with one agent or did not finish and found nothing blocking, or one where a review run failed, keeps the state and only comments. The one exception is a reply-only run on the current head that finds something blocking while the bot's change request stands: it keeps requesting changes. A later full run that finds the pull request ready with every review run finished, or the reply schedule once no open bug thread and nothing waiting is left on the head, dismisses the bot's change request. It takes the same inputs and secrets as `review.yml`; grant the job `pull-requests`, `checks` and `statuses` write:

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

`review.yml` never gets write access, whatever the caller grants. On every run the bot checks its open threads again whose file changed and replies in the ones the validator no longer finds, which closes them for the bot (GitHub lets the job token resolve a thread only with `contents: write`, which the workflow does not ask for, so you resolve it on GitHub), writes a check run per agent, and sets the commit status `MNG Review`: `failure` while bug threads of the bot are open, `success` when none are, `error` when the run did not finish. Require that status in branch protection to gate merges on it. After `limits.max_runs_per_pr` runs, pushes are no longer reviewed. The run caps bound cost, not approval: the count lives in the summary's marker, so while GitHub leaves the newest summary out of a list, a run counts on from an older one, and once everything lists again that run is missing from the count. Declared agents with `input: incremental` review only what changed since the last finished run; the main reviewer always sees the whole change. ADRs 0007 and 0008 record the rules.

Approvals need a GitHub App (see Posting as a GitHub App): GitHub does not let the job token approve, so `github-actions[bot]` comments where the app would approve. The app approves only a push, or a command that named no agent, that finished on the current head and covered the whole change: the main reviewer ran (a quick review never approves) and received every changed file whole (its whole diff, every part of a long diff, or, for a file that deletes no line, every added line through `read_file`), no file was skipped as too large or binary, the token budget stopped nothing, no run failed, and no finding at all was kept, so unverified findings and nits alone leave a comment. A later write dismisses an approval whose head is gone; a run that reviewed an older head never touches an approval or change request on the current one. The review body opens with the state in words (`Approved.`, `Changes requested.` or `Comment.`) and, when the bot did not approve, one sentence that says why, such as "Not approved: 3 of 41 changed files were too large to review." Set `verdict.mode: preview` in `.mng/review.yml` to turn approvals off. Consider it wherever a branch rule requires approving reviews: the bot's approval may count toward that rule, and the reviewed change is text a model reads, which can talk it into finding nothing. Require the `MNG Review` status rather than an approval to gate merges on the bot.

`approve` is the default by the owner's choice. All three council reviewers recommended `preview` instead: a forged or model-fooled empty outcome would approve, and the app's approvals, which do not count toward a pull request's review decision today, would start to count if the app's access changed. The owner kept `approve` because an approval now requires a finished full run on the current head that covered the whole change.

To count threads resolved by hand without waiting for the next push, run the reply schedule (see Replies) together with the status sweep. The sweep runs no model, needs no endpoint secret and only lowers: it turns a status red, or holds a green one back as `pending`, when something blocks again (a reopened bug, a wait for the owner, an unfinished run, an incomplete read). It never writes `success` and dismisses no review, so a run that writes `failure` can never be followed by the sweep's `success`. Every raise holds the pull request's publish group: a run writes `success` or dismisses only in its publish job, and between runs only the reply schedule's `raise` job turns the status green and lifts the bot's change request, so no publishing run writes between its read and its writes; without the reply schedule, only a run turns a status green. The `raise` job also brings a blocking status up to date, a `failure` to `error` once a cleared wait leaves only an unfinished run, or a bug count after some threads are resolved; the sweep never does. The run that follows the last thread resolved by hand does both when its find job already read the resolve; a resolve that lands after that read waits for the next schedule run that actually happens. GitHub runs scheduled workflows on a best-effort basis: it can delay a run or skip it for hours, and a cron that asks for every hour can fire only a few times a day. The reply signal (`workflow_run` after a reply) is the faster path to a raise, and `workflow_dispatch` the manual one. Keep the schedule even when a signal also starts the sweep; its cron is a request to GitHub, not a schedule GitHub keeps:

```yaml
# .github/workflows/mng-review-sweep.yml
name: MNG Review status sweep

on:
  schedule:
    # A request to GitHub, not a promise: runs can come late or be skipped.
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

Without `app-slug` and the two secrets the callers work as above. Setting only some of the three fails before anything is written: in `review-publish.yml` the publish job fails, after the review job has already called the model, and in `status-sweep.yml` the sweep job fails. Only the jobs that write read the key (`publish` in `review-publish.yml`, `sweep` in `status-sweep.yml`, `reserve` and `publish` in `review-command.yml`, `publish` and `raise` in `review-converse.yml`; ADR 0009), and each mints a token for the calling repository with the permissions it needs, which GitHub revokes when the job ends. The review job, which calls the model, never holds the key.

Switching keeps one set of threads and one visible summary. The app answers in the threads `github-actions[bot]` opened, carries the run count over into a new summary and hides the old one, or deletes it when GitHub refuses to hide it. `identity.previous` in `.mng/review.yml` lists the bots whose earlier comments still count; it defaults to `[github-actions]`, and a repository that goes back to the job token sets it to `[your-app-slug]`.

Before you switch:

- A required `MNG Review` check bound to GitHub Actions blocks every pull request once the app sets the status. Set its source to any source before the switch and to the app after it.
- Comments, statuses and check runs the app makes start the repository's other workflows, which writes with `GITHUB_TOKEN` never did. Check workflows that listen to `issue_comment`, `pull_request_review`, `pull_request_review_comment`, `status`, `check_run` or `check_suite`.
- Set `identity.previous: []` once the pull requests opened before the switch are closed. On a pull request that is still open, the bot then posts the findings of the old threads again, and an old summary stays visible next to the new one.
- Pass the two app secrets by name as above. Never use `secrets: inherit`: it exposes every secret of the repository to the reusable workflow, and the names `MNG_REVIEW_APP_CLIENT_ID` and `MNG_REVIEW_APP_PRIVATE_KEY` do not map to its inputs `app-client-id` and `app-private-key`.

### Commands

A person starts a review by mentioning the bot in a pull request comment, alone on its line:

```
@mng-review review
@mng-review review deep
@mng-review review quick
@mng-review run <agent>
```

`review` runs a full review, `deep` and `quick` set its depth, and `run <agent>` runs only that declared agent, on every reviewable file when its `when` rules do not select it. A run of one agent never counts as a full review, so the verdict and the status stay those of the last full review. An agent called `review` is reached with `run review`. The first command in a comment wins. The verbs are lower case, and the handle is compared without case.

Only an admin of the repository, or a login listed in `commands.allow` in the default branch's `.mng/review.yml` that still has write or maintain access, starts a review. For a listed login, a custom repository role counts when its base permission is write or admin; only the built-in admin role makes someone an admin here. Commands start at most `commands.max_runs` reviews per pull request (3 by default). One exception: while the summary is one an incomplete run left (a list GitHub returned was missing an entry), `review` with no agent still runs past the cap, since only a full review that finishes replaces it; post `@mng-review review` to recover. `run <agent>` stays capped. Drafts and `skip.labels` skip a command as they skip a push, unless a `labels.always_review` label is set. A command is a manual run, so `limits.max_runs_per_pr` does not stop it.

A command counts only in a new comment on the pull request's conversation. Editing a comment, the pull request body, a review and a review thread never start one. A mention inside a quote, a code block, an indented block or an HTML comment is ignored, and so is a line that runs on directly after a quote; GitHub's quote reply leaves a blank line after the quote, so a command typed under it still counts. A comment posted through an OAuth app with a user token counts as that user's, since GitHub does not mark it.

Call `review-command.yml` from a workflow of its own:

```yaml
# .github/workflows/mng-review-command.yml
name: MNG Review command

on:
  issue_comment:
    types: [created]

permissions:
  contents: read

jobs:
  review:
    if: >-
      github.event.issue.pull_request &&
      github.event.comment.user.type == 'User' &&
      !github.event.comment.performed_via_github_app &&
      contains(github.event.comment.body, '@mng-review')
    uses: Mnigos/mng-review/.github/workflows/review-command.yml@<commit-sha>
    permissions:
      contents: read
      pull-requests: write
      checks: write
      statuses: write
    with:
      app-slug: mng-review
    secrets:
      llm-url: ${{ secrets.MNG_REVIEW_LLM_URL }}
      llm-key: ${{ secrets.MNG_REVIEW_LLM_KEY }}
      app-client-id: ${{ secrets.MNG_REVIEW_APP_CLIENT_ID }}
      app-private-key: ${{ secrets.MNG_REVIEW_APP_PRIVATE_KEY }}
```

The handle is `app-slug`; use the same text in the caller's `if`, which cannot read the inputs. Without the app, set `handle` to a login instead and leave out the app secrets. There is no default handle: with neither input set the workflow starts no job, and setting both is refused. Reserve the user login that matches the handle, for example by creating an empty organization with that name, so a command never mentions someone else's account.

Each command run shows four jobs. `MNG Review (authorize)` holds no secret and a read-only token and checks the comment, the commenter, the agent and the pull request. `MNG Review (reserve)` counts the manual run in the summary before the endpoint is used, so a run that fails later still counts. `MNG Review (review)` and `MNG Review (publish)` then work as in publish mode. Re-running a command run does nothing after `authorize`; start a failed command again with a new comment. An offline endpoint posts nothing for a command.

`reserve` and the publish jobs, the push one, the command one and the reply schedule's, and the reply schedule's raise job share one concurrency group per pull request, and GitHub keeps only one waiting job per group: a newer waiting job cancels an older waiting one. A command's publish can then be cancelled after its run was counted and the model was paid for, and a command's `reserve` or a reply schedule's publish or raise can cancel a waiting push publish, which leaves that head without a status; a waiting raise can be cancelled by one too, and the next schedule run that actually happens lists it again while it is still due. A reply that comes with a push ("fixed" and the commit) makes the second case likely once the signal below starts the schedule right after the reply. Neither the sweep nor the raise job creates a missing status: the sweep only lowers a status already on the head, and the raise writes one only where the bot's `MNG Review` status is already there (it can still lift a stale change request on that head). A reply publish on that head writes a status, but it answers replies and does not review the push. To get the push reviewed, open the cancelled push run on the Actions tab and re-run its jobs, or post a new command comment such as `@<handle> review` on the pull request; either run reviews the head and writes its status. A pull request that closes or moves to a fork while a command reviews it gets nothing posted.

### Replies

Reply in one of the bot's bug or unverified threads to tell it what happened to the finding:

- `fixed`, after a commit that fixes it. The validator checks the finding again over the change since the thread's commit, without your text. When it no longer holds, the bot answers "no longer found" and stops counting the thread; otherwise it answers that the finding is still found at the head.
- `intentional because` and the reason, with a `path:line` that shows it. A reason that holds against the code, backed by a line that exists outside what the pull request added, is accepted: the bot stops counting the thread and offers one line for `.mng/MEMORY.md`, which counts only once a person merges it. A reason that does not hold is disputed once. A second disagreement, a `critical` finding, a file under `risk_paths` or a severity above `disputes.accept_intentional_up_to` goes to the owner.
- Anything else gets one line saying what the bot understands.

Only the latest comment of a thread counts, and only when a person with write access to the repository wrote it. The bot answers each reply once, at most eight threads per run, and never in a thread that waits for the owner. Answers come with the next push or command run, or sooner when you run the reply schedule. The reply schedule also turns the bot's status green and lifts its change request once nothing blocks: no open bug thread, no bug without a thread, nothing waiting for the owner and no summary an incomplete write left (marked failed and not finished). Only such a summary holds the lift: a full run that simply did not finish still lets the change request go, and its status becomes `error`, not `success`, until a run finishes. Give it and the status sweep one file, started by a short signal after each reply and by a schedule as the fallback, which GitHub runs on a best-effort basis:

```yaml
# .github/workflows/mng-review-schedule.yml
name: MNG Review schedule

on:
  workflow_run:
    workflows: [MNG Review signal]
    types: [completed]
  schedule:
    # A request to GitHub, not a promise: runs can come late or be skipped.
    - cron: '17 * * * *'
  workflow_dispatch:

permissions:
  contents: read

# A run the signal did not earn gets a group of its own, so it never cancels a waiting real one.
concurrency:
  group: >-
    ${{ github.event_name == 'workflow_run' && !(github.event.workflow_run.conclusion == 'success' &&
    github.event.workflow_run.event == 'pull_request_review_comment' &&
    github.event.workflow_run.head_repository.full_name == github.repository) &&
    format('mng-review-skip-{0}', github.run_id) || 'mng-review-schedule' }}
  cancel-in-progress: false

jobs:
  # Answers replies, and turns the status green and lifts the bot's change request once nothing
  # blocks, inside each pull request's publish group; between runs, the only job that raises.
  replies:
    if: >-
      github.event_name != 'workflow_run' ||
      (github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.event == 'pull_request_review_comment' &&
      github.event.workflow_run.head_repository.full_name == github.repository)
    uses: Mnigos/mng-review/.github/workflows/review-converse.yml@<commit-sha>
    permissions:
      contents: read
      pull-requests: write
      statuses: write
    with:
      app-slug: mng-review
    secrets:
      llm-url: ${{ secrets.MNG_REVIEW_LLM_URL }}
      llm-key: ${{ secrets.MNG_REVIEW_LLM_KEY }}
      app-client-id: ${{ secrets.MNG_REVIEW_APP_CLIENT_ID }}
      app-private-key: ${{ secrets.MNG_REVIEW_APP_PRIVATE_KEY }}
  # Lowers the MNG Review status only; it never writes success or dismisses a review.
  sweep:
    if: >-
      github.event_name != 'workflow_run' ||
      (github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.event == 'pull_request_review_comment' &&
      github.event.workflow_run.head_repository.full_name == github.repository)
    uses: Mnigos/mng-review/.github/workflows/status-sweep.yml@<commit-sha>
    permissions:
      contents: read
      pull-requests: write
      statuses: write
    with:
      app-slug: mng-review
    secrets:
      app-client-id: ${{ secrets.MNG_REVIEW_APP_CLIENT_ID }}
      app-private-key: ${{ secrets.MNG_REVIEW_APP_PRIVATE_KEY }}
```

And the signal, in a file of its own:

```yaml
# .github/workflows/mng-review-signal.yml
# Holds no secret and no write token: it runs from the pull request's side, so it only waits and
# ends. "MNG Review schedule" starts from the default branch when it completes.
name: MNG Review signal

on:
  pull_request_review_comment:
    types: [created]

permissions: {}

# A burst of comments keeps one signal running and one waiting.
concurrency:
  group: mng-review-signal
  cancel-in-progress: false

jobs:
  signal:
    if: >-
      github.event.comment.user.type == 'User' &&
      contains(fromJSON('["OWNER","MEMBER","COLLABORATOR","CONTRIBUTOR"]'), github.event.comment.author_association)
    runs-on: ubuntu-latest
    timeout-minutes: 2
    steps:
      - name: Let a resolve that follows the reply land
        run: sleep 15
```

GitHub starts no workflow when a thread is resolved; `pull_request_review_thread` is a webhook event, not a workflow trigger. A reply in a thread does start `pull_request_review_comment`, but that event runs the workflow file from the pull request's merge ref, which a branch can change, so the signal holds nothing and only waits. When it completes, `workflow_run` starts the schedule file from the default branch with the app key, as the cron does; the reusable workflows read nothing from the signal's run. The wait lets a resolve that follows the reply land first, so find counts it: on a quiet repository a reply followed by a resolve turns the status in about a minute. When a schedule run is already busy, the new one waits for it, and a resolve made after find has read the threads waits for the next reply, or for the next scheduled run that GitHub actually starts.

The signal's `if` is a prefilter, not a gate: it skips comments from bots, the bot's own answers included, and from logins with no association to the repository; `CONTRIBUTOR` is let through because a writer whose organization membership is private shows up as one, and a skipped run concludes `skipped`, which the schedule ignores. Whether a reply counts is decided by the find job, which checks write access again. The real gate is in the schedule: it acts only on a successful `pull_request_review_comment` run from this repository, and gives any other run a concurrency group of its own, so a skipped signal never cancels a waiting schedule run. Without it, any workflow named "MNG Review signal" would do: a fork's pull request could rewrite or add one that always succeeds and start the schedule on every comment or push. Within the repository a writer can still do that from a branch, and a branch's rewritten signal runs with the repository's secrets, as any workflow a writer pushes on `push` already does; the signal adds no access a writer did not have. Each extra run costs runner minutes and API reads from the token budget the push reviews share, and pays the model again for a writer's reply whose answer did not land (a refused publish or malformed model output), since find lists that reply again; it never answers, closes or approves anything a writer did not ask for. A reply on a fork's pull request waits for the next scheduled run that GitHub actually starts, or for a run started by hand (`workflow_dispatch`).

A thread resolved with no reply, which includes the common "read the answer, then resolve", waits for the next scheduled run that GitHub actually starts. GitHub runs scheduled workflows on a best-effort basis and can delay or skip them, mostly around the full hour (a minute off the quarter hours fares better); a cron that asks for every hour can fire only two or three times a day, so such a resolve can wait many hours. To have it counted sooner, reply in the thread before resolving it, which starts the signal, or start the schedule by hand (`workflow_dispatch`). On a private repository each schedule run bills about two runner minutes (the find job and the sweep, plus about a minute per pull request with a raise due), so a cron that GitHub ran every 15 minutes would bill about 5,800 minutes a month and one it ran hourly about 1,400, and each writer's review comment adds about one signal minute and one run. The example asks for an hourly run, which bounds those minutes; a public repository, whose minutes are free, can ask for every 15 minutes. Neither cron bounds the wait, since GitHub keeps neither.

A schedule runs from the default branch, so a pull request cannot change it. Each tick, a run of the schedule file whatever started it, lists the open pull requests of this repository with a reply waiting (never drafts or forks), at most `max-pull-requests` (default 5), and answers them one at a time; it reviews no code and posts no new finding, and it does not count toward the run limits. When nothing waits and no raise is due, the replies side of a tick is one short job that holds no secret; the sweep runs on every tick. The find job lists the open pull requests twice, once for the replies and once for the raises. For the replies it reads the review threads of each open, same-repository pull request that is not a draft; only where a thread's latest comment is a person's reply does it also read the pull request's comments, the full comments of the bot's longer threads with a reply, and each replying login's access. For the raises it reads each open pull request's status and reviews, and where the status is not green or the bot's current identity has a change request, the comments, threads and resolvers the status sweep reads, and lists the pull request only when its status would change (to `success`, or a blocking status that no longer says what blocks) or nothing backs that change request, a bug without a thread in the newest summary on any head included; a raise job then judges it again inside the pull request's publish group, after the publish legs, and writes the status and dismisses the change request only while that still holds. It never raises on a list GitHub returned incomplete. Waits count from every summary's list and from the bot's unedited `needs-owner` answers in the threads, so a wait a failed summary write left off the summary still holds the raise until an owner resolves its thread. It also raises nothing while a status that says the run did not finish, such as a failed publish's `error`, was written after the last full run that finished; reply-only runs and command reservations do not count as one, the note stays through lowerings and hand resolves, a time it cannot order counts as after, and only a full run that finishes again releases it. Those full reads (comments, paged threads, whole-thread reads and the resolvers' collaborator roles) go to at most 20 pull requests a tick, on the find job's `github.token`, whose hourly limit every workflow of the repository shares: with a status and a review read for each open pull request the scan reaches, a tick spends at most about 200 requests on full judgments. Remaining limit: a person, not a run that writes in the group, who reopens a thread or records something after the raise job read the review threads and before its writes can still get `success` written or the change request dismissed while a bug is open. The next sweep that actually runs lowers the status again, or the next run's own status replaces it. The sweep, which lowers outside the group, can have its lowering overwritten by a raise only in that same window, when a person acts after the raise job's thread read; the next sweep that actually runs lowers again. Nothing restores the change request: the next push or command run, a command that names one agent included, whose head is still the pull request's head when it writes posts a new one while its verdict still blocks and the reviewer is online, as does a reply-only run on the current head when that head is also the head of the last full review. A reply-only run on the current head but off that head keeps the state, and with the dismissed change request no longer standing it posts none. No run posts one while its list reads left a node out, or on a pull request the bot's identity opened. On a quiet pull request a tick costs one paged thread read, one status read and one review read of the read token's rate limit. The raise scan's first reads, a status and the reviews of each open pull request, cost about 2N requests a tick for N open ones, about 3N with the reply scan's thread reads, plus about 6 to 10 for each full judgment, on the 1,000 requests an hour `github.token` gets per repository, shared with every workflow that reads with it: quiet pull requests alone reach that limit near 330 open ones when the schedule runs hourly and near 80 when it runs every 15 minutes. Past the limit GitHub refuses each read on that token until its hour resets: the raise scan names the pull requests it could not judge and stops after 20 failed judgments, find fails red when no reply read succeeds, and the first tick after the reset reads again. The scan caps only its full judgments; a cap on the first reads would break the coverage bound below. It fails when the reply list fails or no pull request could be read, so a broken schedule shows red; a raise list that fails only skips that tick's raises, says so in the job's line and shows a warning on the run page, so the replies are always listed. The raise scan runs beside the reply scan, judges at most 20 pull requests a tick and starts no judgment two minutes after the step started; it lists what it judged and warns only when the deadline left some out. Three minutes after the step started the scan ends whatever still runs, its listing of the open pull requests included: a judgment that hangs is dropped for that tick and named in a warning, a listing that hangs lists no raise and warns, and the replies and the raises judged so far are still written. Each tick starts s pull requests further, s being the largest step up to 20 that shares no factor with N, the number of open ones, and always judges the one it starts at, so every due pull request is listed within ceil(N / s) ticks, and within N ticks even when the deadline lets a tick judge only one; both hold while N stays the same, since a pull request opened or closed shifts the starts, and both count runs that actually happen, not hours. Without the app, leave out `app-slug` and the app secrets.

A thread that goes to the owner gets one last answer, and the pull request gets the `needs-owner` label, the verdict `needs owner` and a `failure` status until an admin, or a login in `commands.allow` with write access, resolves the thread on GitHub. A writer resolving it or removing the label does not clear it. The next run after the owner resolves it removes the label; the reply schedule turns the status green and lifts the change request sooner, in the run whose find job already read the resolve. A resolve that lands after find read the pull request waits for the next schedule run that actually happens.

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
