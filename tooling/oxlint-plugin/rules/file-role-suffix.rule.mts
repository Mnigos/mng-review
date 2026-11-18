import { defineRule } from '@oxlint/plugins'
import {
	type FilePath,
	getRoleSuffix,
	ROLE_SUFFIXES,
	toFilePath,
} from '../helpers/file-role.helper.mts'

const GENERATED_PATTERN = /\.(?:gen|d)\.ts$/u
/** Entry points whose names the package layout fixes: the CLI's binary and each package's public entry. */
const ENTRY_FILES = new Set(['main.ts', 'index.ts'])

function isIgnored(file: FilePath) {
	return ENTRY_FILES.has(file.basename) || GENERATED_PATTERN.test(file.basename)
}

/**
 * Requires every source file to be named `<kebab-name>.<role>.ts` with a role
 * from the closed AGENTS.md naming table, or `<kebab-name>.<role>.<role>.ts`
 * for a file that belongs to another (`finding.schema.types.ts`), and a spec
 * to carry its source's name plus `.spec.ts`. Package entries (`index.ts`),
 * the CLI entry (`main.ts`) and generated files keep their own names.
 */
export const fileRoleSuffixRule = defineRule({
	meta: {
		type: 'suggestion',
		docs: {
			description:
				'Source files carry a role suffix from the closed AGENTS.md naming table.',
		},
		messages: {
			missingRoleSuffix: `Name the file <kebab-name>.<role>.ts (or <kebab-name>.<role>.<role>.ts) with roles from ${ROLE_SUFFIXES.join(', ')} (AGENTS.md naming table); a spec is <source name>.spec.ts.`,
		},
	},
	create(context) {
		const file = toFilePath(context.filename)

		return {
			Program(node) {
				if (isIgnored(file) || getRoleSuffix(file) !== undefined) return

				context.report({ node, messageId: 'missingRoleSuffix' })
			},
		}
	},
})
