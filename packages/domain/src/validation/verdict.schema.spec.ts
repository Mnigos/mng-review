import { Schema, Result } from 'effect'
import { verdict } from '../shared/mocks/domain-test.helper'
import { verdictSchema } from './verdict.schema'

const VERDICT = verdict()
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
	test.each([
		'src/charge.ts:2',
		'src/charge.ts:2-4 balance update',
		'src/Payment Form.tsx:12 balance update',
	])(
		'unverified accepts repository evidence %s and trims its premise',
		evidence => {
			expect(
				decode({
					...VERDICT,
					verdict: 'unverified',
					evidence: [evidence],
					premise: '  Example SDK retries requests automatically.  ',
				})
			).toEqual(
				Result.succeed({
					...VERDICT,
					verdict: 'unverified',
					evidence: [evidence],
					premise: 'Example SDK retries requests automatically.',
				})
			)
		}
	)
	test.each([undefined, null, '', '   ', 42])(
		'unverified rejects missing or invalid premise %j',
		premise => {
			expect(
				Result.isFailure(
					decode({
						...VERDICT,
						verdict: 'unverified',
						...(premise === undefined ? {} : { premise }),
					})
				)
			).toBeTruthy()
		}
	)
	test.each(
		[
			[],
			['no source location'],
			['src/charge.ts:abc invalid'],
			['src/charge.ts:2suffix invalid'],
			['src/Payment Form.tsx:2suffix invalid'],
		].map(evidence => ({ evidence }))
	)('unverified rejects evidence %j', ({ evidence }) => {
		expect(
			Result.isFailure(
				decode({
					...VERDICT,
					verdict: 'unverified',
					premise: 'Example SDK retries requests automatically.',
					evidence,
				})
			)
		).toBeTruthy()
	})
	test('lowered_because may be omitted', () => {
		expect(decode(VERDICT)).toEqual(Result.succeed(VERDICT))
	})
	test.each([
		null,
		'',
		'   ',
		'  medium does not meet its recovery criterion.  ',
	])('decodes and trims lowered_because %j', loweredBecause => {
		expect(decode({ ...VERDICT, lowered_because: loweredBecause })).toEqual(
			Result.succeed({
				...VERDICT,
				lowered_because: loweredBecause?.trim() ?? null,
			})
		)
	})
	test('rejects a non-string lowered_because', () => {
		expect(
			Result.isFailure(decode({ ...VERDICT, lowered_because: 42 }))
		).toBeTruthy()
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
