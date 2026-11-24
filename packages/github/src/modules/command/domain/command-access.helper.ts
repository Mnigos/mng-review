import { hasWriteRole } from '@mng-review/domain'
import type { CollaboratorRole } from '../../../platform/github-api.schema'

/**
 * True for write access: a built-in role of write or more, or a custom role whose base permission
 * is write or admin. The domain's rule, so the commands, the replies and the acted-on set agree.
 */
export function hasWriteAccess(access: CollaboratorRole): boolean {
	return hasWriteRole(access)
}

/**
 * True for an owner of the bot's decisions: the built-in `admin` role, never a custom one, or a
 * login in `commands.allow`, compared without case, that still has write access.
 */
export function isOwnerAccess(
	login: string,
	access: CollaboratorRole,
	allow: readonly string[]
): boolean {
	const listed = allow.some(
		entry => entry.toLowerCase() === login.toLowerCase()
	)
	return access.role_name === 'admin' || (listed && hasWriteAccess(access))
}
