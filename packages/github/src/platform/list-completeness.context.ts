import { Context, Effect } from 'effect'

/** How a run reads GitHub's connection lists. */
export interface ListReading {
	/** `true`: a node GitHub lists as `null` fails the read; `false`: it is left out. */
	readonly complete: boolean
}

/** The reading of a run whose rules rate, and of one that provides nothing. */
const COMPLETE_READING = { complete: true } as const satisfies ListReading

/**
 * The run's choice for the review threads, a thread's comments, the conversation comments and the
 * reviews. Every step decides it from its rules' `risk.enabled`, never from the gate or the data:
 * while the rating is on, a null node fails the read, also when the gate refuses the run, since it
 * may be the thread, answer or review that holds a level (ADR 0012); rules with the rating off
 * provide `false` (`provideListCompleteness`), so one entry GitHub cannot resolve never stops a
 * publish. Unprovided (deny, risk cleanup, the risk sweep), reads are complete.
 */
export const ListCompleteness = Context.Reference<ListReading>(
	'mng-review/ListCompleteness',
	{ defaultValue: () => COMPLETE_READING }
)

/** Provides the run's list reading: `complete` while the rules set `risk.enabled`. */
export function provideListCompleteness(complete: boolean) {
	return <TValue, TError, TContext>(
		effect: Effect.Effect<TValue, TError, TContext>
	) => Effect.provideService(effect, ListCompleteness, { complete })
}
