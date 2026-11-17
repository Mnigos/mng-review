# MNG Review

Pull request review by agents you declare in your repository.

A built-in main reviewer hunts for bugs on every code change. Agents you write as Markdown files in `.mng/agents/` cover what is specific to your codebase (auth, migrations, billing, conventions) and run only when a change touches their area. A second agent tries to refute every finding before it is posted. The same review runs from the command line before you push and from a GitHub workflow on the pull request.

It talks to any OpenAI-compatible chat completions endpoint. You bring the endpoint and the key.

## Usage

The package is not on npm yet. Run it from a clone with `bun install`, inside the repository you want to review:

```sh
export MNG_REVIEW_LLM_URL=https://your-endpoint/v1
export MNG_REVIEW_LLM_KEY=...

# Which agents would run on this branch, which are skipped and why, and the risk level
bun /path/to/mng-review/src/cli/main.ts plan --base origin/main
```

`--json` prints the same as JSON. Locally the rules come from `.mng/` in the working tree; `--rules-ref <ref>` reads them from a commit instead.

Status: under construction. The design is in [docs/spec.md](docs/spec.md); progress is tracked in the issues.

## License

MIT
