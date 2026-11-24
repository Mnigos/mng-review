import { toAnswerDigest } from '@mng-review/domain'
import {
	fitsNeed,
	isAnswered,
	namesComment,
	toAnswerEntry,
	toAnsweredComment,
} from './answer.helper'

const COMMENT = {
	id: 42,
	at: '2026-01-01T12:00:00Z',
	body: 'confirmed',
} as const

describe('answer versions and kinds', () => {
	test('records the id, edit time and digest of the body read', () => {
		expect(toAnsweredComment(COMMENT)).toEqual({
			id: 42,
			at: COMMENT.at,
			digest: toAnswerDigest(COMMENT.body),
		})
		expect(toAnswerEntry(7, 'review', [])).toBeUndefined()
	})
	for (const change of [
		{ id: 43 },
		{ at: '2026-01-01T12:00:01Z' },
		{ body: 'confirmed.' },
	])
		test(`does not name another current version ${JSON.stringify(change)}`, () => {
			expect(
				namesComment(
					{ ids: [toAnsweredComment(COMMENT)] },
					{ ...COMMENT, ...change }
				)
			).toBe(false)
		})
	for (const kind of ['review', 'cap', 'deny', 'converse', 'run'] as const)
		test(`${kind} answers only fitting command or reply kinds`, () => {
			const entry = { kind, agent: 'auth', ids: [toAnsweredComment(COMMENT)] }
			expect(fitsNeed(entry, { kind: 'review' })).toBe(
				['review', 'cap', 'deny'].includes(kind)
			)
			expect(fitsNeed(entry, { kind: 'converse' })).toBe(kind === 'converse')
			expect(fitsNeed(entry, { kind: 'run', agent: 'auth' })).toBe(
				['run', 'deny'].includes(kind)
			)
			expect(fitsNeed(entry, { kind: 'run', agent: 'storage' })).toBe(
				kind === 'deny'
			)
		})
	test('a later answer that names nothing does not clear a command', () => {
		expect(isAnswered(COMMENT, { kind: 'review' }, [])).toBe(false)
		expect(
			isAnswered(COMMENT, { kind: 'review' }, [
				{
					run: 8,
					kind: 'review',
					ids: [toAnsweredComment(COMMENT)],
					created: '2026-01-01T12:00:01Z',
				},
			])
		).toBe(true)
	})
})

describe('command answers and the answering run', () => {
	const RUN_CREATED = '2026-01-01T12:00:01Z'
	for (const [label, created, answered] of [
		['created after the command', RUN_CREATED, true],
		['created in the same second', COMMENT.at, false],
		['queued before the command', '2026-01-01T11:59:59Z', false],
		['without a creation time', undefined, false],
	] as const)
		for (const kind of ['review', 'run'] as const)
			test(`a ${kind} entry whose run was ${label} answers: ${answered}`, () => {
				const entry = toAnswerEntry(7, kind, [COMMENT], 'auth', created)
				expect(entry?.created).toBe(created)
				expect(
					isAnswered(
						COMMENT,
						kind === 'run' ? { kind, agent: 'auth' } : { kind },
						entry ? [entry] : []
					)
				).toBe(answered)
			})
	test('a denial or a converse answer needs no run time', () => {
		for (const [kind, need] of [
			['deny', { kind: 'review' }],
			['converse', { kind: 'converse' }],
		] as const) {
			const entry = toAnswerEntry(7, kind, [COMMENT])
			expect(isAnswered(COMMENT, need, entry ? [entry] : [])).toBeTruthy()
		}
	})
})
