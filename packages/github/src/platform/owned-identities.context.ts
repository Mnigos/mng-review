import { Context, Effect } from 'effect'
import { type BotIdentity, toOwnedIdentities } from './bot-identity.helper'

/**
 * The bot identities whose comments and statuses count as the bot's: the token's identity first,
 * then `identity.previous` from the rules. Provided once the rules are loaded, so a pull request
 * never decides it for itself.
 */
export class OwnedIdentities extends Context.Service<
	OwnedIdentities,
	{
		/** The identity the token posts as; only its comments are ever edited. */
		readonly current: BotIdentity
		/** `current` first, then the previous identities, no repeats. */
		readonly identities: readonly BotIdentity[]
	}
>()('mng-review/OwnedIdentities') {}

/** Provides the owned identities: the token's `current` identity and the rules' `identity.previous`. */
export function provideOwnedIdentities(
	current: BotIdentity,
	previous: readonly string[]
) {
	return <TValue, TError, TContext>(
		effect: Effect.Effect<TValue, TError, TContext>
	) =>
		Effect.provideService(effect, OwnedIdentities, {
			current,
			identities: toOwnedIdentities(current, previous),
		})
}
