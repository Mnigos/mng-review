import { Schema, Result } from 'effect'
import { verdictSchema } from './verdict.schema'

const VERDICT = {
	verdict: 'confirm',
	severity: 'medium',
	reason: 'Duplicate charge.',
	evidence: ['src/charge.ts:2 balance'],
} as const
const decode = Schema.decodeUnknownResult(verdictSchema)
describe('verdictSchema', () => {
	test('normalizes severity and trims the reason and evidence', () => {
		expect(
			decode({
				...VERDICT,
				severity: 'HIGH',
				reason: '  Duplicate.  ',
				evidence: [' src/charge.ts:2-4 balance '],
			})
		).toEqual(
			Result.succeed({
				verdict: 'confirm',
				severity: 'high',
				reason: 'Duplicate.',
				evidence: ['src/charge.ts:2-4 balance'],
			})
		)
	})
	test('rejection permits no evidence', () => {
		expect(
			Result.isSuccess(decode({ ...VERDICT, verdict: 'reject', evidence: [] }))
		).toBeTruthy()
	})
	test.each(
		[
			[],
			['no source location'],
			['src/charge.ts:abc invalid'],
			['src/charge.ts:2suffix invalid'],
			['src/Payment Form.tsx:2suffix invalid'],
		].map(evidence => ({ evidence }))
	)('confirmation rejects evidence %j', ({ evidence }) => {
		expect(Result.isFailure(decode({ ...VERDICT, evidence }))).toBeTruthy()
	})
	test.each([
		'src/charge.ts:2',
		'src/charge.ts:2-4 balance update',
		'src/Payment Form.tsx:12 balance update',
	])('accepts location %s', evidence => {
		expect(
			Result.isSuccess(decode({ ...VERDICT, evidence: [evidence] }))
		).toBeTruthy()
	})
	test.each(['verdict', 'severity', 'reason', 'evidence'])(
		'requires %s',
		field => {
			const answer = { ...VERDICT }
			expect(
				Result.isFailure(
					decode(
						Object.fromEntries(
							Object.entries(answer).filter(([key]) => key !== field)
						)
					)
				)
			).toBeTruthy()
		}
	)
	test.each([
		{ verdict: 'unknown' },
		{ severity: 'urgent' },
		{ reason: '  ' },
		{ evidence: [5] },
	])('rejects malformed fields %j', overrides => {
		expect(Result.isFailure(decode({ ...VERDICT, ...overrides }))).toBeTruthy()
	})
})
