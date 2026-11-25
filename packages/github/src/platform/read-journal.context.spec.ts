import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { GitHubApiError } from './github.errors'
import { isSameReads, journaled, withReadJournal } from './read-journal.context'

const DENIED = new GitHubApiError({
	operation: 'getCollaboratorRole',
	reason: 'Denied',
	status: 403,
})

layer(Layer.empty)('read journal', test => {
	test.effect('records each read in order with its arguments and answer', () =>
		Effect.gen(function* () {
			const pass = Effect.gen(function* () {
				yield* journaled('listComments', [17], Effect.succeed([{ id: 1 }]))
				yield* journaled('getStatus', ['head'], Effect.succeed(undefined))
				return 'judged'
			})
			expect(yield* withReadJournal(pass)).toEqual({
				value: 'judged',
				reads: [
					JSON.stringify(['listComments', [17], { value: [{ id: 1 }] }]),
					JSON.stringify(['getStatus', ['head'], {}]),
				],
			})
		})
	)
	test.effect('records a failed read and passes its failure on', () =>
		Effect.gen(function* () {
			const pass = journaled(
				'getCollaboratorRole',
				['owner'],
				Effect.fail(DENIED)
			).pipe(Effect.orElseSucceed(() => 'unknown'))
			expect(yield* withReadJournal(pass)).toEqual({
				value: 'unknown',
				reads: [JSON.stringify(['getCollaboratorRole', ['owner'], 'failed'])],
			})
		})
	)
	test.effect('records nothing outside a pass', () =>
		Effect.gen(function* () {
			expect(
				yield* journaled('listComments', [17], Effect.succeed('read'))
			).toBe('read')
			expect(
				(yield* withReadJournal(Effect.succeed('nothing read'))).reads
			).toEqual([])
		})
	)
	test.effect('gives each pass a journal of its own', () =>
		Effect.gen(function* () {
			const read = journaled('listComments', [17], Effect.succeed([]))
			const first = yield* withReadJournal(read)
			const second = yield* withReadJournal(read)
			expect(second.reads).toEqual(first.reads)
			expect(second.reads).toHaveLength(1)
		})
	)
})

const LIST_READ = '["listComments",[17],{"value":[]}]'
const STATUS_READ = '["getStatus",["head"],{}]'

describe('isSameReads', () => {
	const reads = [LIST_READ, STATUS_READ]
	test('holds for the same reads in the same order', () => {
		expect(isSameReads(reads, [LIST_READ, STATUS_READ])).toBeTruthy()
	})
	test.each([
		['another answer', [LIST_READ, '["getStatus",["head"],{"value":1}]']],
		['another order', [STATUS_READ, LIST_READ]],
		['a read more', [LIST_READ, STATUS_READ, LIST_READ]],
		['a read less', [LIST_READ]],
	] as const)('differs with %s', (_name, second) => {
		expect(isSameReads(reads, second)).toBeFalsy()
	})
})
