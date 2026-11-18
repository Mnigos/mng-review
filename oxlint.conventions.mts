import { readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { OxlintOverride } from 'oxlint'

interface RestrictedImportEntry {
	importNames?: readonly string[]
	message: string
}

interface RestrictedImportPath extends RestrictedImportEntry {
	name: string
}

interface RestrictedImportPattern extends RestrictedImportEntry {
	regex: string
}

interface ImportRestriction {
	paths?: readonly RestrictedImportPath[]
	patterns?: readonly RestrictedImportPattern[]
}

const CROSS_WORKSPACE_IMPORT_MESSAGE =
	'Import other apps and packages through their @mng-review/* packages, not relative paths.'
const WORKSPACE_GROUPS = ['apps', 'packages', 'tooling'] as const

const WORKSPACES = WORKSPACE_GROUPS.flatMap(group =>
	readdirSync(join(import.meta.dirname, group), { withFileTypes: true })
		.filter(entry => entry.isDirectory())
		.map(entry => `${group}/${entry.name}`)
)

function getCrossWorkspaceImports(workspace: string) {
	const siblings = WORKSPACES.filter(
		other => other !== workspace && dirname(other) === dirname(workspace)
	).map(other => basename(other))
	const regexes = [
		String.raw`^(\.\./)+(${WORKSPACE_GROUPS.join('|')})/`,
		...(siblings.length > 0
			? [
					String.raw`^(\.\./)+(${siblings.join('|')})(/src(/|$)|/package\.json$|/?$)`,
				]
			: []),
	]

	return {
		patterns: regexes.map(regex => ({
			regex,
			message: CROSS_WORKSPACE_IMPORT_MESSAGE,
		})),
	} satisfies ImportRestriction
}

const VITEST_GLOBALS_MESSAGE =
	'Vitest globals are on: use test, describe, vi and expect without importing them (AGENTS.md).'
const EFFECT_SPEC_MESSAGE =
	"Effect specs import only layer (and its Effect-aware hooks) from @effect/vitest and name the callback's parameter test: layer(TestLayer)('Name', test => test.effect(...)) (AGENTS.md)."

/** Specs use Vitest's globals; `@effect/vitest` is imported only for `layer` and its Effect-aware hooks, so tests keep the name `test`. */
const SPEC_IMPORTS = {
	paths: [
		{
			name: 'vitest',
			importNames: [
				'afterAll',
				'afterEach',
				'beforeAll',
				'beforeEach',
				'describe',
				'expect',
				'it',
				'test',
				'vi',
			],
			message: VITEST_GLOBALS_MESSAGE,
		},
		{
			name: '@effect/vitest',
			importNames: [
				'describe',
				'effect',
				'expect',
				'it',
				'live',
				'prop',
				'test',
				'vi',
			],
			message: EFFECT_SPEC_MESSAGE,
		},
	],
} as const satisfies ImportRestriction

function toRestrictionEntries<TEntry extends RestrictedImportEntry>(
	entries: readonly TEntry[] = []
) {
	return entries.map(({ importNames, ...entry }) => ({
		...entry,
		...(importNames && { importNames: [...importNames] }),
	}))
}

function restrictImports(...restrictions: readonly ImportRestriction[]) {
	return [
		'error',
		{
			paths: restrictions.flatMap(({ paths }) => toRestrictionEntries(paths)),
			patterns: restrictions.flatMap(({ patterns }) =>
				toRestrictionEntries(patterns)
			),
		},
	] satisfies NonNullable<OxlintOverride['rules']>['no-restricted-imports']
}

// oxlint config types use mutable tuples, so rule maps below use satisfies without as const.

export const CONVENTION_RULES = {
	'max-lines': ['error', { max: 400 }],
	'mng-review/declaration-group-spacing': 'error',
	'mng-review/declaration-jsdoc': 'error',
	'mng-review/inferred-type-placement': 'error',
	'mng-review/no-inline-param-type': 'error',
	'mng-review/no-let': 'error',
	'mng-review/type-param-prefix': 'error',
	'typescript/no-non-null-assertion': 'error',
} satisfies OxlintOverride['rules']

export const CONVENTION_SPEC_RULES = {
	'vitest/consistent-test-it': [
		'error',
		{ fn: 'test', withinDescribe: 'test' },
	],
	'vitest/no-restricted-matchers': [
		'error',
		{
			resolves:
				'Assert successful async results with expect(await promise); keep .rejects for errors (AGENTS.md).',
		},
	],
	'vitest/no-restricted-vi-methods': [
		'error',
		{
			hoisted:
				'Define module mocks inline in the vi.mock factory and assert through imported mocked symbols (AGENTS.md).',
		},
	],
} satisfies OxlintOverride['rules']

/** The CLI entry point: the one file that runs effects. */
const ENTRY_FILE = 'apps/cli/src/main.ts'
const ROLE_NAMED_SOURCES = ['apps/*/src/**', 'packages/*/src/**'] as const
const SPEC_FILES = ['**/*.spec.ts'] as const

/** Each override replaces no-restricted-imports wholesale, so every scope lists all restrictions that apply to it. */
export const CONVENTION_OVERRIDES = [
	...WORKSPACES.flatMap(workspace => [
		{
			files: [`${workspace}/**`],
			rules: {
				'no-restricted-imports': restrictImports(
					getCrossWorkspaceImports(workspace)
				),
			},
		},
		{
			files: SPEC_FILES.map(spec => `${workspace}/${spec}`),
			rules: {
				'no-restricted-imports': restrictImports(
					getCrossWorkspaceImports(workspace),
					SPEC_IMPORTS
				),
			},
		},
	]),
	{
		files: [...ROLE_NAMED_SOURCES],
		rules: {
			'mng-review/file-role-suffix': 'error',
			'mng-review/file-role-folder': 'warn',
		},
	},
	{
		files: ['apps/*/src/modules/**', 'packages/*/src/modules/**'],
		rules: { 'mng-review/module-name': 'error' },
	},
	{
		files: ['apps/**', 'packages/**'],
		rules: {
			'mng-review/no-default-runtime': 'error',
			'mng-review/redacted-secret-config': 'error',
		},
	},
	{
		files: [ENTRY_FILE],
		rules: { 'mng-review/no-default-runtime': 'off' },
	},
	{
		files: [...SPEC_FILES, '**/vitest.*.ts', '**/vitest.*.mts'],
		rules: {
			'mng-review/test-hook-spacing': 'error',
			'typescript/require-await': 'off',
		},
	},
	{
		files: [...SPEC_FILES],
		rules: { 'max-lines': 'off' },
	},
] satisfies OxlintOverride[]
