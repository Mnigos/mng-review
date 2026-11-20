import { GITHUB_ACTIONS_SLUG } from '@mng-review/domain'
import type { CommentAuthor } from './github-api.schema'

/** A bot account the workflow posts as, or once posted as; both forms are lower-cased. */
export interface BotIdentity {
	/** The login GraphQL gives the bot: the app's slug, such as `mng-review` or `github-actions`. */
	readonly login: string
	/** The login REST gives the bot: the slug with `[bot]`. */
	readonly restLogin: string
}

/** The job token's bot, `github-actions[bot]`. */
export const GITHUB_ACTIONS_IDENTITY = toBotIdentity(GITHUB_ACTIONS_SLUG)

/** The identity of a bot by its slug, compared without case everywhere. */
export function toBotIdentity(slug: string): BotIdentity {
	const login = slug.toLowerCase()
	return { login, restLogin: `${login}[bot]` }
}

/** The identities whose comments count as the bot's: the current one first, then `previous`, no repeats. */
export function toOwnedIdentities(
	current: BotIdentity,
	previous: readonly string[]
): readonly BotIdentity[] {
	const logins = new Set([
		current.login,
		...previous.map(slug => slug.toLowerCase()),
	])
	return [...logins].map(toBotIdentity)
}

/** True for a `Bot` whose login is one of `owned`, so a user account named like it never counts. */
export function isOwnedBot(
	actor: CommentAuthor | null,
	owned: readonly BotIdentity[]
): boolean {
	return (
		actor?.__typename === 'Bot' &&
		owned.some(identity => identity.login === actor.login.toLowerCase())
	)
}

/** True for a `Bot` with the identity's login. */
export function isIdentity(
	actor: CommentAuthor | null,
	identity: BotIdentity
): boolean {
	return isOwnedBot(actor, [identity])
}

/** Who made something, as REST names it. */
export interface RestActor {
	readonly login: string
	readonly type: string
}

/** True when a REST creator, such as a commit status's, is a `Bot` among `owned`. */
export function isOwnedCreator(
	creator: RestActor | null,
	owned: readonly BotIdentity[]
): boolean {
	return (
		creator?.type === 'Bot' &&
		owned.some(identity => identity.restLogin === creator.login.toLowerCase())
	)
}
