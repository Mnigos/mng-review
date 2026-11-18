import { defineRule, type ESTree } from '@oxlint/plugins'

const DEFAULT_RUNTIME_RUNNERS = new Set([
	'runCallback',
	'runFork',
	'runPromise',
	'runPromiseExit',
	'runSync',
	'runSyncExit',
])
/** Platform runtimes whose `runMain` starts the process; only an app entry calls it. */
const PLATFORM_RUNTIMES = new Set(['BunRuntime', 'NodeRuntime'])

/** Local names that refer to `Effect`: the global name and any alias imported from `effect`. */
type EffectNames = ReadonlySet<string>

function getRunner(node: ESTree.MemberExpression, effectNames: EffectNames) {
	if (
		node.computed ||
		node.object.type !== 'Identifier' ||
		node.property.type !== 'Identifier'
	)
		return

	const { name } = node.property

	if (effectNames.has(node.object.name) && DEFAULT_RUNTIME_RUNNERS.has(name))
		return `Effect.${name}`
	if (PLATFORM_RUNTIMES.has(node.object.name) && name === 'runMain')
		return `${node.object.name}.${name}`
}

/**
 * Forbids running an effect anywhere but an app entry: `Effect.runSync`,
 * `Effect.runPromise`, `Effect.runFork`, their `Exit` variants,
 * `Effect.runCallback` (including named imports of them from `effect/Effect`)
 * and `BunRuntime.runMain`/`NodeRuntime.runMain`. Library code returns
 * effects, and `apps/cli/src/main.ts` and `apps/action/src/main.ts` run them
 * once with every layer provided; those files turn this rule off in
 * `oxlint.conventions.mts`. Specs
 * run effects through `@effect/vitest`.
 */
export const noDefaultRuntimeRule = defineRule({
	meta: {
		type: 'problem',
		docs: {
			description: 'Effects run only in an app entry point.',
		},
		messages: {
			defaultRuntime:
				'{{ name }} runs an effect outside an app entry (apps/*/src/main.ts); return the effect and let the entry point run it (AGENTS.md).',
		},
	},
	create(context) {
		const effectNames = new Set(['Effect'])

		return {
			MemberExpression(node) {
				const name = getRunner(node, effectNames)

				if (name)
					context.report({ node, messageId: 'defaultRuntime', data: { name } })
			},
			ImportDeclaration(node) {
				if (node.source.value === 'effect')
					for (const specifier of node.specifiers)
						if (
							specifier.type === 'ImportSpecifier' &&
							specifier.imported.type === 'Identifier' &&
							specifier.imported.name === 'Effect'
						)
							effectNames.add(specifier.local.name)
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
