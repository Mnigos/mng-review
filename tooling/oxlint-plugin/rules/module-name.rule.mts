import { defineRule, type ESTree } from '@oxlint/plugins'
import { getRoleSuffix, toFilePath } from '../helpers/file-role.helper.mts'

const MODULE_FILE_PATTERN =
	/^(?:.*\/)?(?:apps|packages)\/[^/]+\/src\/modules\/([^/]+)\//u
const MODULE_NAMED_ROLES = new Set(['service'])

function toPascalCase(name: string) {
	return name
		.split('-')
		.map(word => word.charAt(0).toUpperCase() + word.slice(1))
		.join('')
}

/** Classes the file exports, directly (`export class X`) or through a local export list (`export { X }`). */
function getExportedClassNames(program: ESTree.Program) {
	const classes = new Set(
		program.body.flatMap(statement => {
			const declaration =
				statement.type === 'ExportNamedDeclaration'
					? statement.declaration
					: statement

			return declaration?.type === 'ClassDeclaration' && declaration.id
				? [declaration.id.name]
				: []
		})
	)
	const exported = program.body.flatMap(statement => {
		if (statement.type !== 'ExportNamedDeclaration') return []
		if (
			statement.declaration?.type === 'ClassDeclaration' &&
			statement.declaration.id
		)
			return [statement.declaration.id.name]
		if (statement.source) return []

		return statement.specifiers.flatMap(specifier =>
			specifier.local.type === 'Identifier' &&
			specifier.exported.type === 'Identifier' &&
			classes.has(specifier.local.name)
				? [specifier.exported.name]
				: []
		)
	})

	return exported
}

/**
 * Keeps service names tied to their file (AGENTS.md module names). A module
 * may hold several services, so inside `<workspace>/src/modules/<module>/` a
 * `<name>.service.ts` file exports the `<Name>Service` class: `router.service.ts`
 * exports `RouterService`. Specs are not checked.
 */
export const moduleNameRule = defineRule({
	meta: {
		type: 'suggestion',
		docs: {
			description: 'A service file exports the service class named after it.',
		},
		messages: {
			missingServiceClass:
				'{{name}}.service.ts exports the {{className}} class (AGENTS.md module names).',
		},
	},
	create(context) {
		const file = toFilePath(context.filename)
		const module = MODULE_FILE_PATTERN.exec(file.path)?.[1]
		const role = getRoleSuffix(file)

		return {
			Program(node) {
				if (!(module && role && MODULE_NAMED_ROLES.has(role))) return
				if (file.basename.endsWith('.spec.ts')) return

				const name = file.basename.split('.')[0] ?? ''
				const className = `${toPascalCase(name)}Service`

				if (!getExportedClassNames(node).includes(className))
					context.report({
						node,
						messageId: 'missingServiceClass',
						data: { name, className },
					})
			},
		}
	},
})
