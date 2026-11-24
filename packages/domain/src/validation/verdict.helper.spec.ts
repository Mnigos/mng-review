import { verdict } from '../shared/mocks/domain-test.helper'
import {
	getEvidencePaths,
	toValidation,
	UNNAMED_PREMISE,
} from './verdict.helper'
import {
	MAX_PREMISE_CHARS,
	MAX_VERDICT_REASON_CHARS,
	type Verdict,
	VERDICTS,
} from './verdict.schema'

const MODEL = 'validator-model'
const STATUS_BY_VERDICT = {
	confirm: 'confirmed',
	reject: 'rejected',
	unverified: 'unverified',
} as const satisfies Record<Verdict['verdict'], string>

describe('getEvidencePaths', () => {
	test('extracts paths with lines, ranges, spaces and notes, normalizes and deduplicates them', () => {
		expect(
			getEvidencePaths([
				'  ./src//charge.ts:2 balance  ',
				'src/nested/../charge.ts:5-9 guard',
				'src/Payment Form.tsx:12',
				'.mng/MEMORY.md:1 intentional',
			])
		).toEqual(['src/charge.ts', 'src/Payment Form.tsx', '.mng/MEMORY.md'])
	})
	test.each([
		'',
		'no source location',
		'src/charge.ts',
		'src/charge.ts:abc',
		'../outside.ts:1',
		'src/../../outside.ts:2',
		'/absolute.ts:3',
		'C:/outside.ts:4',
		'src\\charge.ts:5',
		'src/\0charge.ts:6',
		'.:1',
		'./:1',
		'src/..:1',
	])('skips missing locations, unsafe paths and the root: %j', evidence => {
		expect(getEvidencePaths([evidence])).toEqual([])
	})
	test('empty evidence has no paths', () => {
		expect(getEvidencePaths([])).toEqual([])
	})
})

describe('toValidation', () => {
	for (const verdictName of VERDICTS) {
		const premise =
			verdictName === 'unverified'
				? 'Example SDK retries automatically.'
				: undefined
		const status = STATUS_BY_VERDICT[verdictName]
		test(`${verdictName} preserves equal severity, reason, evidence and model without notes`, () => {
			const answer = verdict({
				verdict: verdictName,
				...(premise ? { premise } : {}),
			})
			expect(
				toValidation({
					verdict: answer,
					reported: answer.severity,
					model: MODEL,
					hasRepositoryEvidence: true,
				})
			).toEqual({
				status,
				severity: answer.severity,
				reason: answer.reason,
				evidence: answer.evidence,
				model: MODEL,
				...(premise ? { premise } : {}),
			})
		})
		for (const loweredBecause of [undefined, null, ''])
			test(`${verdictName} retains the reported severity when lowering has explanation ${JSON.stringify(loweredBecause)}`, () => {
				const answer = verdict({
					verdict: verdictName,
					severity: 'low',
					lowered_because: loweredBecause,
					...(premise ? { premise } : {}),
				})
				const validation = toValidation({
					verdict: answer,
					reported: 'high',
					model: MODEL,
					hasRepositoryEvidence: true,
				})
				expect(validation).toMatchObject({
					status,
					severity: 'high',
					note: expect.stringContaining(
						'without naming the criterion'
					) as unknown,
				})
				expect(validation.note).toContain('high')
				expect(validation.note).toContain('low')
				expect(validation).not.toHaveProperty('loweredBecause')
			})
		test(`${verdictName} accepts an explained lowering and records its reason`, () => {
			const loweredBecause =
				'high: no request or main flow fails and no user receives wrong data.'
			const validation = toValidation({
				verdict: verdict({
					verdict: verdictName,
					severity: 'medium',
					lowered_because: loweredBecause,
					...(premise ? { premise } : {}),
				}),
				reported: 'high',
				model: MODEL,
				hasRepositoryEvidence: true,
			})
			expect(validation).toMatchObject({
				status,
				severity: 'medium',
				loweredBecause,
				...(premise ? { premise } : {}),
			})
			expect(validation).not.toHaveProperty('note')
		})
		test(`${verdictName} can raise severity without an explanation`, () => {
			const validation = toValidation({
				verdict: verdict({
					verdict: verdictName,
					severity: 'critical',
					...(premise ? { premise } : {}),
				}),
				reported: 'high',
				model: MODEL,
				hasRepositoryEvidence: true,
			})
			expect(validation).toMatchObject({ status, severity: 'critical' })
			expect(validation).not.toHaveProperty('note')
			expect(validation).not.toHaveProperty('loweredBecause')
		})
	}
	test.each(['medium', 'critical'] as const)(
		'ignores an unused lowering explanation at %s severity',
		severity => {
			const validation = toValidation({
				verdict: verdict({ severity, lowered_because: 'Unused explanation.' }),
				reported: 'medium',
				model: MODEL,
				hasRepositoryEvidence: true,
			})
			expect(validation.severity).toBe(severity)
			expect(validation).not.toHaveProperty('loweredBecause')
			expect(validation).not.toHaveProperty('note')
		}
	)
	for (const severity of ['low', 'high', 'critical'] as const)
		for (const loweredBecause of [
			undefined,
			'high: only recoverable UI behaviour fails.',
		])
			test(`unsupported rejection at ${severity} with lowering reason ${JSON.stringify(loweredBecause)} stays at reported severity`, () => {
				const answer = verdict({
					verdict: 'reject',
					severity,
					evidence: [],
					...(loweredBecause ? { lowered_because: loweredBecause } : {}),
				})
				expect(
					toValidation({
						verdict: answer,
						reported: 'high',
						model: MODEL,
						hasRepositoryEvidence: false,
					})
				).toEqual({
					status: 'unverified',
					severity: 'high',
					reason: answer.reason,
					evidence: [],
					model: MODEL,
					premise: UNNAMED_PREMISE,
					note: expect.stringContaining(
						'without citing lines of this repository'
					) as unknown,
				})
			})
	test('unsupported rejection retains the validator premise', () => {
		const premise = 'Example SDK passes an absolute URL.'
		expect(
			toValidation({
				verdict: verdict({ verdict: 'reject', premise }),
				reported: 'medium',
				model: MODEL,
				hasRepositoryEvidence: false,
			})
		).toMatchObject({ status: 'unverified', premise })
	})
	test('unverified uses the fallback premise if called without a named premise', () => {
		expect(
			toValidation({
				verdict: verdict({ verdict: 'unverified', premise: null }),
				reported: 'medium',
				model: MODEL,
				hasRepositoryEvidence: false,
			})
		).toMatchObject({ status: 'unverified', premise: UNNAMED_PREMISE })
	})
	test('confirmation does not require the rejection evidence check', () => {
		expect(
			toValidation({
				verdict: verdict(),
				reported: 'medium',
				model: MODEL,
				hasRepositoryEvidence: false,
			})
		).toMatchObject({ status: 'confirmed', severity: 'medium' })
	})
})

describe('validated edit retention', () => {
	test.each(VERDICTS)('keeps an edit only for %s confirmation', name => {
		const edit = {
			commit: 'a'.repeat(40),
			line: 2,
			original: 'old()',
			replacement: 'new()',
		} as const
		const validation = toValidation({
			verdict: verdict({ verdict: name, premise: 'A package retries.' }),
			reported: 'high',
			model: MODEL,
			hasRepositoryEvidence: true,
			edit,
		})
		if (name === 'confirm') expect(validation).toHaveProperty('edit', edit)
		else expect(validation).not.toHaveProperty('edit')
	})
	test('does not retain an edit when an unsupported rejection becomes unverified', () => {
		expect(
			toValidation({
				verdict: verdict({ verdict: 'reject' }),
				reported: 'high',
				model: MODEL,
				hasRepositoryEvidence: false,
				edit: {
					commit: 'a'.repeat(40),
					line: 2,
					original: 'old()',
					replacement: 'new()',
				},
			})
		).not.toHaveProperty('edit')
	})
})

describe('verdict text limits', () => {
	test.each(VERDICTS)(
		'cuts an over-long reason and premise of a %s answer at a word boundary and keeps its status',
		name => {
			const validation = toValidation({
				verdict: verdict({
					verdict: name,
					reason: 'because '.repeat(200).trim(),
					premise: 'retries '.repeat(100).trim(),
				}),
				reported: 'high',
				model: MODEL,
				hasRepositoryEvidence: true,
			})
			expect(validation.status).toBe(STATUS_BY_VERDICT[name])
			expect(validation.reason.length).toBeLessThanOrEqual(
				MAX_VERDICT_REASON_CHARS
			)
			expect(validation.reason).toMatch(/because…$/u)
			if (validation.status !== 'unverified') return
			expect(validation.premise.length).toBeLessThanOrEqual(MAX_PREMISE_CHARS)
			expect(validation.premise).toMatch(/retries…$/u)
		}
	)
	test('keeps a reason and premise exactly at the limits', () => {
		const reason = 'x'.repeat(MAX_VERDICT_REASON_CHARS)
		const premise = 'y'.repeat(MAX_PREMISE_CHARS)
		expect(
			toValidation({
				verdict: verdict({ verdict: 'unverified', reason, premise }),
				reported: 'high',
				model: MODEL,
				hasRepositoryEvidence: true,
			})
		).toMatchObject({ reason, premise })
	})
})
