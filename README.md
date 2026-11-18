# MNG Review

Pull request review by agents you declare in your repository.

A built-in main reviewer hunts for bugs on every code change. Agents you write as Markdown files in `.mng/agents/` cover what is specific to your codebase (auth, migrations, billing, conventions) and run only when a change touches their area. A second agent tries to refute every finding before it is posted. The same review runs from the command line before you push and from a GitHub workflow on the pull request.

It talks to any OpenAI-compatible chat completions endpoint. You bring the endpoint and the key.

## Status

Under construction. The design is in [docs/spec.md](docs/spec.md); progress is tracked in the issues. Usage instructions arrive with the CLI.

## Development

A Bun workspace on Effect 4: `packages/domain` (schemas and pure logic), `packages/engine` (services) and `apps/cli` (the `mng-review` binary). [CONTRIBUTING.md](CONTRIBUTING.md) lists the commands; [ARCHITECTURE.md](ARCHITECTURE.md) maps the code.

## License

MIT
