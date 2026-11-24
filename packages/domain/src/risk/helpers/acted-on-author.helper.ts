import { GITHUB_ACTIONS_SLUG } from '../../config/review-config.constants'
import {
	BUILT_IN_ROLES,
	PERSON_TYPE,
	WRITE_PERMISSIONS,
	WRITE_ROLES,
} from '../risk.constants'
import type { CommentAuthor, RepositoryRole } from '../risk.types'

/**
 * True for write access: a built-in role of write or more, or a custom role whose base permission
 * is write or admin. A built-in role is judged by its name alone.
 */
export function hasWriteRole(role: RepositoryRole): boolean {
	if (BUILT_IN_ROLES.some(name => name === role.role_name))
		return WRITE_ROLES.some(name => name === role.role_name)
	return WRITE_PERMISSIONS.some(permission => permission === role.permission)
}

/** True for a login of `github-actions` or an owned bot, with or without `[bot]`, without case. */
function isBotLogin(login: string, owned: readonly string[]): boolean {
	const name = login.toLowerCase()
	return [GITHUB_ACTIONS_SLUG, ...owned].some(slug => {
		const bot = slug.toLowerCase()
		return name === bot || name === `${bot}[bot]`
	})
}

/**
 * True when the bot acts on the author's comments: a person (`User`, not posted through an app, not
 * an owned bot login, not `github-actions[bot]`) whose role, read when the rule asks, has write
 * access. `author_association` never decides it. A failed role read is the caller's to fail on.
 */
export function isActedOnAuthor(
	author: CommentAuthor,
	role: RepositoryRole,
	owned: readonly string[]
): boolean {
	if (author.type !== PERSON_TYPE || author.viaApp) return false
	if (isBotLogin(author.login, owned)) return false
	return hasWriteRole(role)
}
