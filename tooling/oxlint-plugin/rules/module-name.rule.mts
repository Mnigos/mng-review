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

function getExportedClassNames(program: ESTree.Program) {
	return program.body.flatMap(statement =>
		statement.type === 'ExportNamedDeclaration' &&
		statement.declaration?.type === 'ClassDeclaration' &&
		statement.declaration.id
			? [statement.declaration.id.name]
			: []
	)
}

/**
 * Keeps names tied to their module (AGENTS.md module names). Inside
 * `<workspace>/src/modules/<module>/`, a `.service.ts` file is named
 * `<module>.service.ts` and exports the `<Module>Service` class; its spec
 * shares the name without the export. Files about one entity
 * (`finding.errors.ts`, `finding.schema.ts`) are not checked.
 */
export const moduleNameRule = defineRule({
	meta: {
		type: 'suggestion',
		docs: {
			description: 'Module services reuse the module name as is.',
		},
		messages: {
			wrongFileName:
				'A .{{role}}.ts file in modules/{{module}} is named {{module}}.{{role}}.ts (AGENTS.md module names).',
			missingServiceClass:
				'{{module}}.service.ts exports the {{className}} class (AGENTS.md module names).',
		},
	},
	create(context) {
		const file = toFilePath(context.filename)
		const module = MODULE_FILE_PATTERN.exec(file.path)?.[1]
		const role = getRoleSuffix(file)

		return {
			Program(node) {
				if (!(module && role && MODULE_NAMED_ROLES.has(role))) return

				if (file.basename.split('.')[0] !== module) {
					context.report({
						node,
						messageId: 'wrongFileName',
						data: { role, module },
					})

					return
				}

				if (file.basename.endsWith('.spec.ts')) return

				const className = `${toPascalCase(module)}Service`

				if (!getExportedClassNames(node).includes(className))
					context.report({
						node,
						messageId: 'missingServiceClass',
						data: { module, className },
					})
			},
		}
	},
})
