import { Context, Effect, Exit, Ref } from 'effect'

/**
 * The GitHub reads of one pass, each one entry that serializes the operation, its arguments and
 * what it returned, or that it failed, in the order the pass made them. Unset outside a pass
 * (`withReadJournal`), where reads are not recorded.
 */
export const ReadJournal = Context.Reference<
	Ref.Ref<readonly string[]> | undefined
>('mng-review/ReadJournal', { defaultValue: () => undefined })

/** The arguments of one recorded read. */
export type ReadArguments = readonly (string | number | boolean | undefined)[]

/** What a pass returned beside every read it made (`ReadJournal`). */
export interface JournaledPass<TValue> {
	readonly value: TValue
	readonly reads: readonly string[]
}

/** `read`, the `operation` with `args`, recorded in the open read journal, if any. */
export function journaled<TValue, TError, TContext>(
	operation: string,
	args: ReadArguments,
	read: Effect.Effect<TValue, TError, TContext>
): Effect.Effect<TValue, TError, TContext> {
	return Effect.gen(function* () {
		const journal = yield* ReadJournal
		if (!journal) return yield* read
		return yield* read.pipe(
			Effect.onExit(exit =>
				Ref.update(journal, entries => [
					...entries,
					JSON.stringify([
						operation,
						args,
						Exit.isSuccess(exit) ? { value: exit.value } : 'failed',
					]),
				])
			)
		)
	})
}

/** Runs `pass` with a read journal of its own and returns what it read beside its value. */
export function withReadJournal<TValue, TError, TContext>(
	pass: Effect.Effect<TValue, TError, TContext>
): Effect.Effect<JournaledPass<TValue>, TError, TContext> {
	return Effect.gen(function* () {
		const journal = yield* Ref.make<readonly string[]>([])
		const value = yield* Effect.provideService(pass, ReadJournal, journal)
		return { value, reads: yield* Ref.get(journal) }
	})
}

/** True when two passes made the same reads in the same order and got the same answers. */
export function isSameReads(
	first: readonly string[],
	second: readonly string[]
): boolean {
	return (
		first.length === second.length &&
		first.every((entry, index) => entry === second[index])
	)
}
