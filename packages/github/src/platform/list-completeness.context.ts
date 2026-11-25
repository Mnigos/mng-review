import { Context, Effect, Ref } from 'effect'
import { collect } from './github-api.helper'
import type { ConnectionPage } from './github-api.schema'
import type { GitHubApiError } from './github.errors'

/** The lists a run may read leniently, by the operation that reads each, as reasons name them. */
export const LENIENT_LISTS = {
	listReviewThreads: 'review threads',
	listThreadComments: 'thread comments',
	listComments: 'conversation comments',
	listReviews: 'reviews',
} as const
/** An operation that reads one of the lenient lists. */
export type ListOperation = keyof typeof LENIENT_LISTS
/** A lenient list as the reasons name it. */
export type LenientList = (typeof LENIENT_LISTS)[ListOperation]

/** How a run reads GitHub's connection lists, and what its lenient reads left out. */
export interface ListReading {
	/** `true`: a node GitHub lists as `null` fails the read; `false`: it is left out. */
	readonly complete: boolean
	/**
	 * The list of each null node the run's lenient reads left out so far, one entry per node; any
	 * at all marks the run incomplete.
	 */
	readonly dropped: Ref.Ref<readonly LenientList[]>
}

/**
 * The reading of a run whose rules rate, and of one that provides nothing. Its reads fail on a null
 * node, so its record never grows and can be shared.
 */
const COMPLETE_READING = {
	complete: true,
	dropped: Ref.makeUnsafe<readonly LenientList[]>([]),
} as const satisfies ListReading

/**
 * The run's choice for the review threads, a thread's comments, the conversation comments and the
 * reviews. Every step decides it from its rules' `risk.enabled`, never from the gate or the data:
 * while the rating is on, a null node fails the read, also when the gate refuses the run, since it
 * may be the thread, answer or review that holds a level (ADR 0012); rules with the rating off
 * provide `false` (`provideListCompleteness`), so one entry GitHub cannot resolve never stops a
 * publish, and the run counts what it left out (`isReadIncomplete`). Unprovided (deny, risk
 * cleanup, the risk sweep), reads are complete.
 */
export const ListCompleteness = Context.Reference<ListReading>(
	'mng-review/ListCompleteness',
	{ defaultValue: () => COMPLETE_READING }
)

/**
 * Provides the run's list reading: `complete` while the rules set `risk.enabled`. Each run of the
 * effect starts its own count of left-out nodes.
 */
export function provideListCompleteness(complete: boolean) {
	return <TValue, TError, TContext>(
		effect: Effect.Effect<TValue, TError, TContext>
	) =>
		Ref.make<readonly LenientList[]>([]).pipe(
			Effect.flatMap(dropped =>
				Effect.provideService(effect, ListCompleteness, { complete, dropped })
			)
		)
}

/**
 * Runs `effect` with the run's list reading and a count of its own, for a run over several pull
 * requests whose left-out nodes must not mark the next one.
 */
export function restartListCount<TValue, TError, TContext>(
	effect: Effect.Effect<TValue, TError, TContext>
): Effect.Effect<TValue, TError, TContext> {
	return Effect.gen(function* () {
		const { complete } = yield* ListCompleteness
		return yield* provideListCompleteness(complete)(effect)
	})
}

/** How many nodes of `page` GitHub listed as `null`. */
function countNullNodes<TNode>(
	page: ConnectionPage<TNode> | undefined
): number {
	return page?.nodes.filter(node => node === null).length ?? 0
}

/**
 * Every node of a connection read as the run reads lists (`collect`). A lenient read counts the
 * null nodes of each page as it arrives, so a later page that fails keeps the count.
 */
export function collectListed<TNode>(
	operation: ListOperation,
	fetchPage: (
		cursor: string | null
	) => Effect.Effect<ConnectionPage<TNode> | undefined, GitHubApiError>
): Effect.Effect<readonly TNode[], GitHubApiError> {
	return Effect.gen(function* () {
		const { complete, dropped } = yield* ListCompleteness
		if (complete) return yield* collect(operation, fetchPage, true, null, 0)
		const list = LENIENT_LISTS[operation]
		const counted = (cursor: string | null) =>
			fetchPage(cursor).pipe(
				Effect.tap(page =>
					Ref.update(dropped, lists => [
						...lists,
						...Array.from({ length: countNullNodes(page) }, () => list),
					])
				)
			)
		return yield* collect(operation, counted, false, null, 0)
	})
}

/**
 * True once a lenient read of this run left out a null node: what it read may miss a thread, an
 * answer or a review, so the run raises no approval: it approves nothing, writes no `success`,
 * lifts no change request, clears no wait and posts no new thread (ADR 0012).
 */
export const isReadIncomplete: Effect.Effect<boolean> = Effect.gen(
	function* () {
		const { dropped } = yield* ListCompleteness
		return (yield* Ref.get(dropped)).length > 0
	}
)

/** The lists this run's lenient reads left a null node out of, each once, in `LENIENT_LISTS` order. */
export const getIncompleteLists: Effect.Effect<readonly LenientList[]> =
	Effect.gen(function* () {
		const { dropped } = yield* ListCompleteness
		const lists = new Set(yield* Ref.get(dropped))
		return Object.values(LENIENT_LISTS).filter(list => lists.has(list))
	})

/** What one read returned, and whether its lenient list reads left a null node out. */
export interface ListedRead<TValue> {
	readonly value: TValue
	readonly incomplete: boolean
}

/**
 * Runs `effect` and says whether its own list reads left a node out, for a reader that must treat
 * that list as unknown. The run's reads are sequential, so the count's change is this read's.
 */
export function readListed<TValue, TError, TContext>(
	effect: Effect.Effect<TValue, TError, TContext>
): Effect.Effect<ListedRead<TValue>, TError, TContext> {
	return Effect.gen(function* () {
		const { dropped } = yield* ListCompleteness
		const before = (yield* Ref.get(dropped)).length
		const value = yield* effect
		return { value, incomplete: (yield* Ref.get(dropped)).length > before }
	})
}
