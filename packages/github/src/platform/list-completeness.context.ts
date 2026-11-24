import { Context, Effect } from 'effect'

/** How a run reads GitHub's connection lists. */
export interface ListReading {
	/** `true`: a node GitHub lists as `null` fails the read; `false`: it is left out. */
	readonly complete: boolean
}

/** The reading of a run that rates, and of one that provides nothing. */
const COMPLETE_READING = { complete: true } as const satisfies ListReading

/**
 * The run's choice for the review threads, a thread's comments, the conversation comments and the
 * reviews. The risk gate decides it, never the data: while the rating is on, a null node fails the
 * read, since it may be the thread, answer or review that holds a level (ADR 0012); a run that does
 * not rate provides `false` (`provideListCompleteness`), so one entry GitHub cannot resolve never
 * stops a publish. Unprovided, reads are complete.
 */
export const ListCompleteness = Context.Reference<ListReading>(
	'mng-review/ListCompleteness',
	{ defaultValue: () => COMPLETE_READING }
)

/** Provides the run's list reading: `complete` while the risk gate rates. */
export function provideListCompleteness(complete: boolean) {
	return <TValue, TError, TContext>(
		effect: Effect.Effect<TValue, TError, TContext>
	) => Effect.provideService(effect, ListCompleteness, { complete })
}
