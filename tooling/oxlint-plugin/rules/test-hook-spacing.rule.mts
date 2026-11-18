import { defineRule, type ESTree, type Fixer } from '@oxlint/plugins'

type BodyStatement = ESTree.Program['body'][number]

const LIFECYCLE_HOOKS = new Set([
	'beforeEach',
	'afterEach',
	'beforeAll',
	'afterAll',
])

/**
 * Tells whether a statement is a bare lifecycle hook call such as
 * `beforeEach(...)`, or its Playwright form `test.beforeEach(...)`.
 */
export function isLifecycleHook(statement: BodyStatement) {
	if (
		statement.type !== 'ExpressionStatement' ||
		statement.expression.type !== 'CallExpression'
	)
		return false

	const { callee } = statement.expression

	if (callee.type === 'Identifier') return LIFECYCLE_HOOKS.has(callee.name)

	return (
		callee.type === 'MemberExpression' &&
		!callee.computed &&
		callee.object.type === 'Identifier' &&
		callee.object.name === 'test' &&
		callee.property.type === 'Identifier' &&
		LIFECYCLE_HOOKS.has(callee.property.name)
	)
}

/**
 * Keeps lifecycle hooks (`beforeEach`, `afterEach`, `beforeAll`, `afterAll`)
 * apart from their sibling statements: a hook needs a blank line before and
 * after it, consecutive hooks included, unless it opens or closes its block.
 * An own-line comment above a hook belongs to it, so the blank line goes above
 * the comment. Declarations between hooks are not checked.
 */
export const testHookSpacingRule = defineRule({
	meta: {
		type: 'layout',
		docs: {
			description:
				'Lifecycle hooks are separated from sibling statements by a blank line.',
		},
		fixable: 'whitespace',
		messages: {
			missingBlankLineAroundHook:
				'Separate lifecycle hooks from sibling statements with a blank line (AGENTS.md).',
		},
	},
	create(context) {
		const { sourceCode } = context

		function getGap(
			previous: BodyStatement,
			next: BodyStatement
		): ESTree.Span[] {
			return [
				previous,
				...sourceCode.getTokensBetween(previous, next, {
					includeComments: true,
				}),
				next,
			]
		}

		function hasBlankLine(gap: ESTree.Span[]) {
			return gap.some((item, index) => {
				const previous = gap[index - 1]

				return previous && item.loc.start.line - previous.loc.end.line > 1
			})
		}

		function checkPair(previous: BodyStatement, next: BodyStatement) {
			if (!(isLifecycleHook(previous) || isLifecycleHook(next))) return

			const gap = getGap(previous, next)

			if (hasBlankLine(gap)) return

			const ownLineIndex = gap.findIndex(
				item => item.loc.start.line > previous.loc.end.line
			)
			const lineEnd = gap[ownLineIndex - 1]
			const ownLine = gap[ownLineIndex]

			if (!(lineEnd && ownLine)) return

			context.report({
				node: next,
				messageId: 'missingBlankLineAroundHook',
				fix: (fixer: Fixer) => {
					const whitespace = sourceCode.text.slice(lineEnd.end, ownLine.start)
					const newline = /\r\n?|\n/.exec(whitespace)?.[0] ?? '\n'

					return fixer.insertTextAfterRange([lineEnd.end, lineEnd.end], newline)
				},
			})
		}

		function checkBody(body: readonly BodyStatement[]) {
			for (const [index, statement] of body.entries()) {
				const previous = body[index - 1]

				if (previous) checkPair(previous, statement)
			}
		}

		return {
			Program(node) {
				checkBody(node.body)
			},
			BlockStatement(node) {
				checkBody(node.body)
			},
		}
	},
})
