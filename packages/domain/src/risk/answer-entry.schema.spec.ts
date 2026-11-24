import { Schema } from 'effect'
import { answerEntrySchema } from './answer-entry.schema'
import { DIGEST_FIXTURES } from './risk-fixtures.constants'
import { ANSWER_KINDS } from './risk.constants'

const COMMENT = {
	id: 12,
	at: '2026-01-02T03:04:05Z',
	digest: DIGEST_FIXTURES[0].digest,
} as const
const ENTRY = { run: 34, kind: 'review', ids: [COMMENT] } as const
const decode = Schema.decodeUnknownSync(answerEntrySchema)

describe('answer entries', () => {
	test.each(ANSWER_KINDS)('accepts %s with agent only for run', kind => {
		const entry = {
			...ENTRY,
			kind,
			...(kind === 'run' ? { agent: 'auth' } : {}),
		}
		expect(decode(entry)).toEqual(entry)
	})
	test('preserves multiple named comment versions', () => {
		const entry = {
			...ENTRY,
			ids: [COMMENT, { ...COMMENT, id: 13, digest: DIGEST_FIXTURES[1].digest }],
		}
		expect(decode(entry)).toEqual(entry)
	})
	test.each([
		{ ...ENTRY, kind: 'run' },
		...ANSWER_KINDS.filter(kind => kind !== 'run').map(kind => ({
			...ENTRY,
			kind,
			agent: 'auth',
		})),
		{ ...ENTRY, kind: 'run', agent: '' },
		{ ...ENTRY, kind: 'run', agent: '-auth' },
		{ ...ENTRY, kind: 'unknown' },
		{ ...ENTRY, ids: [] },
		...[0, -1, 1.5, '34'].map(run => ({ ...ENTRY, run })),
		...[0, -1, 1.5, '12'].map(id => ({ ...ENTRY, ids: [{ ...COMMENT, id }] })),
		...['a'.repeat(15), 'a'.repeat(17), 'A'.repeat(16), 'g'.repeat(16), ''].map(
			digest => ({ ...ENTRY, ids: [{ ...COMMENT, digest }] })
		),
		...[
			'2026-01-02',
			'2026-1-02T03:04:05Z',
			'2026-01-02T03:04:05.000Z',
			'2026-01-02T03:04:05+00:00',
			'not-a-time',
			'',
		].map(at => ({ ...ENTRY, ids: [{ ...COMMENT, at }] })),
	])('rejects malformed entry %j', entry => {
		expect(() => decode(entry)).toThrow()
	})
	test.each(['digest', 'at'] as const)(
		'rejects trailing newline in %s',
		field => {
			expect(() =>
				decode({
					...ENTRY,
					ids: [{ ...COMMENT, [field]: `${COMMENT[field]}\n` }],
				})
			).toThrow()
		}
	)
})
