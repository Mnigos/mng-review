import { AGENTS_DIR } from '../agents/agent.constants'
import {
	CONFIG_PATH,
	CONTEXT_PATH,
	MEMORY_PATH,
} from '../config/review-config.constants'
import type { RulesFile } from './init.types'

/** First line of every `review.yml` that `init` writes. */
export const REVIEW_YML_HEADER =
	'# MNG Review settings. Keys left out take their value from the preset in `extends`.\n'
/** Headings of `CONTEXT.md` the main reviewer is steered by. */
export const CONTEXT_HEADINGS = [
	'## Intentional patterns, not bugs',
	'## Where real bugs tend to hide',
] as const

const STARTER_REVIEW_YML = `${REVIEW_YML_HEADER}extends: mng:default

# Changes under these globs are always reviewed at deep depth.
risk_paths: []

skip:
  # Files no agent reads, such as generated code.
  paths: []
`

const STARTER_CONTEXT = `# Review context

What this repository is and how it is built, in two or three sentences.

${CONTEXT_HEADINGS[0]}

- A pattern that looks wrong but is deliberate, so reviewers do not report it.

${CONTEXT_HEADINGS[1]}

- An area where mistakes are likely and costly, such as retries, permission checks or migrations.
`

const STARTER_BUG_AGENT = `---
title: Example bug agent
kind: bug
when:
  paths: ['src/**']
  exclude: ['**/*.spec.ts', '**/*.test.ts']
  triage: 'changes who may read or write which data'
input: incremental
---
Rename this file and replace these instructions with one area of bugs to hunt for.

Trace every changed handler to the check that proves the caller may touch the data it reads or writes. Report a handler that reaches the data without that check.
`

const STARTER_NIT_AGENT = `---
title: Example convention check
kind: nit
when:
  paths: ['src/**']
input: incremental
---
Rename this file and replace these rules with your repository's conventions. Nits are batched into one review and never block a merge.

- Exported functions have a short comment that says what they are for.
- Errors are returned as values, never thrown.
`

/** The starter `.mng/` of `mng-review init`. */
export const STARTER_FILES = [
	{ path: CONFIG_PATH, text: STARTER_REVIEW_YML },
	{ path: CONTEXT_PATH, text: STARTER_CONTEXT },
	{ path: MEMORY_PATH, text: '' },
	{ path: `${AGENTS_DIR}/example-bug.md`, text: STARTER_BUG_AGENT },
	{ path: `${AGENTS_DIR}/example-nit.md`, text: STARTER_NIT_AGENT },
] as const satisfies readonly RulesFile[]
