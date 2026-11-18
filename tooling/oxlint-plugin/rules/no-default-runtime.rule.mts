import { defineRule, type ESTree } from '@oxlint/plugins'

const DEFAULT_RUNTIME_RUNNERS = new Set([
	'runCallback',
	'runFork',
	'runPromise',
	'runPromiseExit',
	'runSync',
	'runSyncExit',
])
/** Platform runtimes whose `runMain` starts the process; only the CLI entry calls it. */
const PLATFORM_RUNTIMES = new Set(['BunRuntime', 'NodeRuntime'])

function getRunner(node: ESTree.MemberExpression) {
	if (
		node.computed ||
		node.object.type !== 'Identifier' ||
		node.property.type !== 'Identifier'
	)
		return

	const { name } = node.property

	if (node.object.name === 'Effect' && DEFAULT_RUNTIME_RUNNERS.has(name))
		return `Effect.${name}`
	if (PLATFORM_RUNTIMES.has(node.object.name) && name === 'runMain')
		return `${node.object.name}.${name}`
}

/**
 * Forbids running an effect anywhere but the CLI entry: `Effect.runSync`,
 * `Effect.runPromise`, `Effect.runFork`, their `Exit` variants,
 * `Effect.runCallback` (including named imports of them from `effect/Effect`)
 * and `BunRuntime.runMain`/`NodeRuntime.runMain`. Library code returns
 * effects, and `apps/cli/src/main.ts` runs them once with every layer
 * provided; that file turns this rule off in `oxlint.conventions.mts`. Specs
 * run effects through `@effect/vitest`.
 */
export const noDefaultRuntimeRule = defineRule({
	meta: {
		type: 'problem',
		docs: {
			description: 'Effects run only in the CLI entry point.',
		},
		messages: {
			defaultRuntime:
				'{{ name }} runs an effect outside apps/cli/src/main.ts; return the effect and let the entry point run it (AGENTS.md).',
		},
	},
	create(context) {
		return {
			MemberExpression(node) {
				const name = getRunner(node)

				if (name)
					context.report({ node, messageId: 'defaultRuntime', data: { name } })
			},
			ImportDeclaration(node) {
				if (node.source.value !== 'effect/Effect') return

				for (const specifier of node.specifiers)
					if (
						specifier.type === 'ImportSpecifier' &&
						specifier.imported.type === 'Identifier' &&
						DEFAULT_RUNTIME_RUNNERS.has(specifier.imported.name)
					)
						context.report({
							node: specifier,
							messageId: 'defaultRuntime',
							data: { name: `Effect.${specifier.imported.name}` },
						})
			},
		}
	},
})
