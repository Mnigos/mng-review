import { defineConfig, type OxlintOverride } from 'oxlint'
import core from 'ultracite/oxlint/core'
import {
	CONVENTION_OVERRIDES,
	CONVENTION_RULES,
	CONVENTION_SPEC_RULES,
} from './oxlint.conventions.mts'

const DISABLED_RULES = {
	'class-methods-use-this':
		'Effect services and errors use getters without this',
	'func-names': 'anonymous function expressions are fine as callbacks',
	'max-classes-per-file': 'error files group related tagged errors',
	'no-await-in-loop': 'sequential scripts are intentional',
	'no-plusplus': 'increment operators are idiomatic in counters and loops',
	'prefer-named-capture-group':
		'positional groups are clearer in short regexes',
	'sort-keys':
		'key order carries meaning: effect/cli lists flags and arguments in declaration order',
	'require-await':
		'conflicts with typescript/promise-function-async on pass-through promise callbacks',
	'node/callback-return':
		'Effect middleware yields next(), not Node-style callbacks',
	'promise/prefer-await-to-callbacks':
		'Effect and CLI APIs take callbacks by design',
	'promise/prefer-await-to-then': 'fire-and-forget void promises',
	'typescript/no-confusing-void-expression':
		'concise void-returning arrow callbacks per AGENTS.md',
	'typescript/non-nullable-type-assertion-style':
		'pushes towards non-null assertions, banned by AGENTS.md',
	'typescript/prefer-nullish-coalescing':
		'AGENTS.md uses || for intentional all-falsy checks',
	'typescript/strict-boolean-expressions':
		'truthiness checks and || fallbacks are intentional',
	'typescript/unbound-method': 'Effect passes methods as references',
	'unicorn/throw-new-error':
		'reads the Schema.TaggedError<T>()(...) class factory as a thrown error; Effect code never throws',
	'unicorn/import-style': 'named imports from Node builtins are the convention',
	'unicorn/no-array-reduce': 'reduce is accepted for aggregations',
	'unicorn/no-useless-undefined':
		'AGENTS.md prefers explicit undefined at API boundaries',
	'unicorn/prefer-ternary': 'AGENTS.md prefers early returns over ternaries',
	'unicorn/switch-case-braces':
		'AGENTS.md skips braces for single-statement blocks',
} as const satisfies Record<string, string>

/** The vendored rule sources in tooling/oxlint-plugin do not pass these rules yet; fix the rules before removing an entry. */
const VENDORED_PLUGIN_DEFERRED_RULES = [
	'require-unicode-regexp',
	'mng-review/no-let',
	'typescript/consistent-return',
	'typescript/no-unnecessary-type-assertion',
	'typescript/strict-void-return',
	'unicorn/consistent-function-scoping',
] as const

const PRESETS = [core]

const SPEC_PLUGINS = [
	...new Set([
		...PRESETS.flatMap(preset => preset.plugins ?? []),
		'vitest',
	] satisfies OxlintOverride['plugins']),
]

export default defineConfig({
	extends: PRESETS,
	ignorePatterns: [...(core.ignorePatterns ?? []), '.claude/**'],
	jsPlugins: ['./tooling/oxlint-plugin/mng-review.plugin.mts'],
	options: { typeAware: true },
	env: { node: true, es2024: true },
	globals: { Bun: 'readonly' },
	rules: {
		...Object.fromEntries(
			Object.keys(DISABLED_RULES).map(rule => [rule, 'off'])
		),
		curly: 'off',
		'func-style': ['error', 'declaration', { allowArrowFunctions: true }],
		'import/consistent-type-specifier-style': [
			'error',
			'prefer-top-level-if-only-type-imports',
		],
		'import/no-default-export': 'error',
		'import/no-duplicates': ['error', { preferInline: true }],
		'no-nested-ternary': 'off',
		'no-undef': 'error',
		'no-use-before-define': [
			'error',
			{
				classes: false,
				functions: false,
				ignoreTypeReferences: true,
				typedefs: false,
				variables: false,
			},
		],
		'no-void': 'off',
		'oxc/no-barrel-file': 'off',
		'prefer-arrow-callback': ['error', { allowNamedFunctions: true }],
		'typescript/consistent-type-imports': [
			'error',
			{ disallowTypeAnnotations: false, fixStyle: 'inline-type-imports' },
		],
		'typescript/no-misused-promises': [
			'error',
			{ checksVoidReturn: { attributes: false } },
		],
		'typescript/switch-exhaustiveness-check': [
			'error',
			{ considerDefaultExhaustiveForUnions: true },
		],
		...CONVENTION_RULES,
	},
	overrides: [
		{
			// Their tool loads them only through the default export: commitlint, oxlint (config and plugin), oxfmt and Vitest.
			files: [
				'commitlint.config.ts',
				'oxlint.config.mts',
				'oxfmt.config.mts',
				'vitest.config.mts',
				'**/vitest.config.ts',
				'tooling/oxlint-plugin/mng-review.plugin.mts',
			],
			rules: { 'import/no-default-export': 'off' },
		},
		{
			files: ['apps/*/src/**', 'packages/*/src/**'],
			rules: { 'oxc/no-barrel-file': ['error', { threshold: 0 }] },
		},
		{
			// The one root entry per package that AGENTS.md allows.
			files: ['apps/*/src/index.ts', 'packages/*/src/index.ts'],
			rules: { 'oxc/no-barrel-file': 'off' },
		},
		{
			files: ['tooling/oxlint-plugin/**'],
			rules: Object.fromEntries(
				VENDORED_PLUGIN_DEFERRED_RULES.map(rule => [rule, 'off'])
			),
		},
		{
			files: ['**/*.spec.ts'],
			env: { vitest: true },
			plugins: SPEC_PLUGINS,
			rules: {
				'vitest/expect-expect': 'off',
				'vitest/max-nested-describe': 'error',
				'vitest/no-conditional-expect': 'off',
				'vitest/no-disabled-tests': 'error',
				'vitest/no-duplicate-hooks': 'error',
				'vitest/no-focused-tests': 'error',
				'vitest/prefer-snapshot-hint': 'off',
				'vitest/require-mock-type-parameters': 'off',
				'vitest/require-to-throw-message': 'off',
				'vitest/valid-expect': 'off',
				'vitest/warn-todo': 'off',
				'no-loop-func': 'off',
				'promise/valid-params': 'off',
				'typescript/await-thenable': 'off',
				'typescript/dot-notation': 'off',
				'typescript/no-base-to-string': 'off',
				'typescript/no-explicit-any': 'off',
				'typescript/no-invalid-void-type': 'off',
				'typescript/no-misused-promises': [
					'error',
					{ checksVoidReturn: false },
				],
				...CONVENTION_SPEC_RULES,
			},
		},
		...CONVENTION_OVERRIDES,
	] satisfies OxlintOverride[],
})
