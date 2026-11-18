# Contributing

Run every command from the repository root. Read `AGENTS.md` for the code rules, `ARCHITECTURE.md` for where code goes and `docs/spec.md` for what the tool does.

## Setup

You need Bun 1.4.2 or newer and Node.js 22.22.1 or newer. Vitest runs on Node; the CLI runs on Bun.

```sh
bun install --frozen-lockfile
```

`bun install` also installs the git hooks: `pre-commit` runs `lint-staged` (Ultracite fixes the staged files) and `commit-msg` runs commitlint.

## Commands

| Task                      | Command                                    |
| ------------------------- | ------------------------------------------ |
| Lint and format check     | `bun run check`                            |
| Fix lint and format       | `bun run check:fix`                        |
| Typecheck every workspace | `bun run typecheck`                        |
| Unit tests                | `bun run test`                             |
| Unit tests in watch mode  | `bun run test:watch`                       |
| One workspace's tests     | `bun run test --filter @mng-review/engine` |
| Build the CLI             | `bun run build`                            |
| Run the CLI from source   | `bun apps/cli/src/main.ts --help`          |

Use `bun run test`, not `bun test`. The repository runs Vitest; `bun test` starts Bun's own test runner.

### Adding a tested workspace

The root `vitest.config.mts` runs each `apps/*/vitest.config.ts` and `packages/*/vitest.config.ts` as its own Vitest project, named after the workspace's package. A new workspace needs its own `vitest.config.ts` with `globals: true` and a `test` script:

```json
"test": "vitest run --root ../.. --project @mng-review/<name> --passWithNoTests"
```

## Commits

Commits follow [Conventional Commits](https://www.conventionalcommits.org): `type(scope): subject`, for example `feat(engine): route agents by changed paths` or `build: pin vitest`. commitlint checks every commit in the hook and in CI. `bun run commit` opens the commitizen prompt.

Scopes are workspaces (`cli`, `domain`, `engine`, `oxlint-plugin`, `typescript-config`) or areas (`deps`, `ci`, `docs`). Never skip the hooks with `--no-verify`.

## Pull requests

CI runs commitlint on the pull request's commits, then `bun install --frozen-lockfile`, `bun run check`, `bun run typecheck`, `bun run test` and `bun run build`. Keep a pull request to one change; a fix to an unrelated file goes in its own pull request.
