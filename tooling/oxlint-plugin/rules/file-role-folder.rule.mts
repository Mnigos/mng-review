import { defineRule } from '@oxlint/plugins'
import {
	getRoleSuffixes,
	hasSegment,
	type RoleSuffix,
	toFilePath,
} from '../helpers/file-role.helper.mts'

const ROLE_FOLDERS = {
	repository: ['infrastructure'],
	layer: ['infrastructure', 'platform'],
	parser: ['domain', 'infrastructure'],
	mapper: ['infrastructure'],
	query: ['infrastructure'],
	client: ['infrastructure', 'platform'],
	port: ['application'],
	service: ['application', 'platform'],
	tool: ['application'],
	toolkit: ['application'],
	command: ['presentation'],
	formatter: ['presentation'],
	util: ['src/utils'],
} as const satisfies Partial<Record<RoleSuffix, readonly string[]>>

type FolderBoundRole = keyof typeof ROLE_FOLDERS

function isFolderBoundRole(role: string | undefined): role is FolderBoundRole {
	return role !== undefined && Object.hasOwn(ROLE_FOLDERS, role)
}

/**
 * Warns when a role-suffixed file sits outside the layer that owns the role,
 * e.g. a `.repository.ts` outside `infrastructure/` or a `.command.ts` outside
 * `presentation/`. Both roles of a two-role name count, so
 * `git.client.types.ts` also belongs in `infrastructure/` or `platform/`.
 */
export const fileRoleFolderRule = defineRule({
	meta: {
		type: 'suggestion',
		docs: {
			description: 'Role-suffixed files live in the folder that owns the role.',
		},
		messages: {
			wrongFolder:
				'A .{{role}}.ts file belongs in {{folders}} (AGENTS.md naming table).',
		},
	},
	create(context) {
		const file = toFilePath(context.filename)
		const roles = getRoleSuffixes(file).filter(isFolderBoundRole)

		return {
			Program(node) {
				for (const role of roles) {
					const folders: readonly string[] = ROLE_FOLDERS[role]

					if (folders.some(folder => hasSegment(file, folder))) continue

					context.report({
						node,
						messageId: 'wrongFolder',
						data: {
							role,
							folders: folders.map(folder => `${folder}/`).join(' or '),
						},
					})
				}
			},
		}
	},
})
