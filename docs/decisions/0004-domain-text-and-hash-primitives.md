# ADR 0004: Effect's Yaml and Glob and node:crypto in the domain package

**Status:** Proposed
**Date:** 2026-11-18

## Context

`packages/domain` parses `.mng/review.yml` and agent front matter (YAML), matches `when.paths`, `exclude`, `risk_paths` and `skip.paths` (globs), and hashes finding fingerprints. The prototype used `Bun.YAML`, `Bun.Glob` and `node:crypto`. Specs run on Vitest under Node 22 (ADR 0003), so the domain cannot use Bun globals. The owner's reference repositories use no YAML parser or glob matcher, so they do not settle the choice.

## Decision

- YAML: `Yaml.parse` from `effect/encoding` (Effect 4.1.4, behaviour based on `yaml` 2.9). It throws a `SyntaxError`, which the domain turns into a `ConfigError` naming the file. Unsupported YAML (compact nested sequences, tags, document streams, complex keys) is not needed for `review.yml` or front matter.
- Writing YAML: Effect 4.1.4 has no YAML writer. `toYamlText` in `domain/src/utils` writes the block subset `mng-review init` needs (mappings, lists, strings, numbers, booleans) and quotes a string whenever a plain scalar would read back differently. `init` decodes every file it writes with the rule schemas before writing.
- Globs: `Glob.make` and `Glob.match` from `effect`, compiled once per pattern with `dot: true`, so `src/**` covers `src/.env` as `Bun.Glob` did. The domain adds two rules on top: `dir/**` matches `dir` itself, and a pattern without `/` matches the file name in any directory, as in `.gitignore`.
- Fingerprints: SHA-256 from `node:crypto`, cut to 16 hex characters. It is synchronous and pure, runs on Node and Bun, and gives the same value on every machine, which the hidden block of a thread needs to recognise a finding on a later run. `@types/node` (catalog, Node 22 line) is a dev dependency of `domain` instead of `@types/bun`, so Bun globals do not typecheck there.

## Consequences

- `domain` keeps one runtime dependency, `effect`. No `yaml`, `js-yaml`, `picomatch` or `minimatch` in the catalog.
- `effect/encoding` `Yaml` and `Glob` are marked unstable and experimental in 4.1.4. The exact Effect pin (ADR 0002) keeps their behaviour fixed until a deliberate upgrade; the config and routing specs cover the behaviour the domain relies on.
- Changing the fingerprint hash or its length changes every fingerprint, so threads from earlier runs would no longer match their findings.
- Rejected: the `yaml` and `picomatch` packages (more dependencies for what Effect ships), Effect's `Digest` service (a service with a layer, which `domain` may not hold, and asynchronous), and `Hash.string` from `effect` (a 32-bit in-memory hash whose values are not meant to be persisted).

## Related

- `ARCHITECTURE.md`: Package layering
- ADR 0002: Effect for schemas, services and the CLI
- ADR 0003: naming, layering and test conventions
