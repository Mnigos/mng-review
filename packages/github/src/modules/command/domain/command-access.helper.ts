import type { CollaboratorRole } from '../../../platform/github-api.schema'

/** GitHub's built-in repository roles; any other `role_name` is a custom role. */
const BUILT_IN_ROLES = ['admin', 'maintain', 'write', 'triage', 'read'] as const
/** Built-in roles with write access. */
const WRITE_ROLES = ['admin', 'maintain', 'write'] as const
/** Base permissions a custom role must map to for write access. */
const WRITE_PERMISSIONS = ['admin', 'write'] as const

/**
 * True for write access: a built-in role of write or more, or a custom role whose base permission
 * is write or admin.
 */
export function hasWriteAccess(access: CollaboratorRole): boolean {
	if (BUILT_IN_ROLES.some(role => role === access.role_name))
		return WRITE_ROLES.some(role => role === access.role_name)
	return WRITE_PERMISSIONS.some(permission => permission === access.permission)
}
