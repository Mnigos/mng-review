import { FINGERPRINT_LENGTH, type Validation } from '@mng-review/domain'
import { type ReviewReport, toEmptyReviewReport } from '@mng-review/engine'
import { Schema } from 'effect'
import { expectTypeOf } from 'vitest'
import { bug } from '../../../shared/mocks/publish-test.helper'
import { reviewReport } from '../../../shared/mocks/review-report.helper'
import {
	MAX_REPORT_ENTRIES,
	MAX_REPORT_FILES,
	MAX_REPORT_NAME,
	MAX_REPORT_TEXT,
	reviewReportSchema,
} from './review-report.schema'

const decode = Schema.decodeUnknownSync(
	Schema.fromJsonString(reviewReportSchema)
)

/** Serializes the same way the outcome writer does before decoding. */
function roundTrip(value: unknown) {
	return decode(JSON.stringify(value))
}

describe('reviewReportSchema', () => {
	test('preserves the complete shared report across JSON serialization', () => {
		const report = reviewReport()
		expect(roundTrip(report)).toEqual(report)
		expectTypeOf(roundTrip(report)).toExtend<ReviewReport>()
	})
	test('decodes an empty review with the omitted skippedRun key restored', () => {
		const report = toEmptyReviewReport(reviewReport().planReport, 0)
		expect(roundTrip(report)).toEqual(report)
		expect(roundTrip(report).planReport.plan).toHaveProperty(
			'skippedRun',
			undefined
		)
	})
	test.each(['confirmed', 'rejected', 'unverified', 'unvalidated'] as const)(
		'preserves the %s validation variant',
		status => {
			const details = {
				severity: 'high',
				reason: 'The write repeats.',
				evidence: ['src/store.ts:10'],
				model: 'model-a',
			} as const
			const validation: Validation =
				status === 'unvalidated'
					? { status, error: 'Validator failed.', budgetSpent: true }
					: status === 'unverified'
						? { ...details, status, premise: 'The caller retries.' }
						: { ...details, status }
			const report = { ...reviewReport(), bugs: [bug({ validation })] }
			expect(roundTrip(report).bugs[0]?.validation).toEqual(validation)
		}
	)
	test.each([
		'../outside.ts',
		'src/../store.ts',
		'/src/store.ts',
		'src\\store.ts',
	])('rejects a non-normalized path %s', path => {
		expect(() =>
			roundTrip({ ...reviewReport(), bugs: [bug({ path })] })
		).toThrow()
	})
	test.each(['bugs', 'nits', 'rejected'] as const)(
		'rejects unsafe, long and uppercase fingerprints in %s',
		field => {
			const report = reviewReport()
			for (const fingerprint of [
				'<'.repeat(FINGERPRINT_LENGTH),
				'a'.repeat(FINGERPRINT_LENGTH + 1),
				'A'.repeat(FINGERPRINT_LENGTH),
			])
				expect(() =>
					roundTrip({
						...report,
						[field]: report[field].map(finding => ({
							...finding,
							fingerprint,
						})),
					})
				).toThrow()
		}
	)
	test.each(['agents', 'models'] as const)(
		'accepts bounded finding %s and rejects an oversized name or list',
		field => {
			const report = reviewReport()
			const names = Array.from({ length: 50 }, () =>
				'a'.repeat(MAX_REPORT_NAME)
			)
			expect(
				roundTrip({
					...report,
					bugs: [bug({ [field]: names })],
				}).bugs[0]?.[field]
			).toEqual(names)
			for (const list of [
				['a'.repeat(MAX_REPORT_NAME + 1)],
				Array.from({ length: 51 }, () => 'model-a'),
			])
				expect(() =>
					roundTrip({
						...report,
						bugs: [bug({ [field]: list })],
					})
				).toThrow()
		}
	)
	test.each(['/src/store.ts', '../store.ts', 'src/../store.ts'])(
		'rejects a router signal with path %s',
		path => {
			const report = reviewReport()
			expect(() =>
				roundTrip({
					...report,
					planReport: {
						...report.planReport,
						plan: {
							...report.planReport.plan,
							router: {
								...report.planReport.plan.router,
								signals: [
									{ category: 'stored_data', path, reason: 'Writes data.' },
								],
							},
						},
					},
				})
			).toThrow()
		}
	)
	test.each([
		'base',
		'a'.repeat(39),
		'g'.repeat(40),
		'a'.repeat(41),
		'b'.repeat(63),
		'g'.repeat(64),
	])('rejects invalid commit %s in every commit field', commit => {
		const report = reviewReport()
		const { change } = report.planReport
		for (const replacement of [
			{ ...change, base: { ...change.base, commit } },
			{ ...change, head: { ...change.head, commit } },
			{ ...change, mergeBase: commit },
		])
			expect(() =>
				roundTrip({
					...report,
					planReport: { ...report.planReport, change: replacement },
				})
			).toThrow()
	})
	test.each([40, 64])('accepts %i hexadecimal commit characters', length => {
		const report = reviewReport()
		const { change } = report.planReport
		const commit = 'abcdef01'.repeat(length / 8)
		expect(
			roundTrip({
				...report,
				planReport: {
					...report.planReport,
					change: {
						...change,
						base: { ...change.base, commit },
						head: { ...change.head, commit },
						mergeBase: commit,
					},
				},
			}).planReport.change.mergeBase
		).toBe(commit)
	})
	test.each(['bugs', 'nits', 'rejected', 'agents'] as const)(
		'rejects more than MAX_REPORT_ENTRIES in %s',
		field => {
			const report = reviewReport()
			expect(() =>
				roundTrip({
					...report,
					[field]: Array.from(
						{ length: MAX_REPORT_ENTRIES + 1 },
						() => report[field][0]
					),
				})
			).toThrow()
		}
	)
	test.each(['runs', 'skips'] as const)(
		'rejects more than MAX_REPORT_ENTRIES in plan.%s',
		field => {
			const report = reviewReport()
			expect(() =>
				roundTrip({
					...report,
					planReport: {
						...report.planReport,
						plan: {
							...report.planReport.plan,
							[field]: Array.from(
								{ length: MAX_REPORT_ENTRIES + 1 },
								() => report.planReport.plan[field][0]
							),
						},
					},
				})
			).toThrow()
		}
	)
	test.each(['change', 'plan'] as const)(
		'rejects more than MAX_REPORT_FILES in %s.files',
		field => {
			const report = reviewReport()
			expect(() =>
				roundTrip({
					...report,
					planReport: {
						...report.planReport,
						[field]: {
							...report.planReport[field],
							files: Array.from(
								{ length: MAX_REPORT_FILES + 1 },
								() => report.planReport[field].files[0]
							),
						},
					},
				})
			).toThrow()
		}
	)
	test('accepts the entry and title bounds and rejects a title one character over', () => {
		const report = reviewReport()
		expect(
			roundTrip({
				...report,
				bugs: Array.from({ length: MAX_REPORT_ENTRIES }, () =>
					bug({ title: 'x'.repeat(MAX_REPORT_TEXT) })
				),
			}).bugs
		).toHaveLength(MAX_REPORT_ENTRIES)
		expect(() =>
			roundTrip({
				...report,
				bugs: [bug({ title: 'x'.repeat(MAX_REPORT_TEXT + 1) })],
			})
		).toThrow()
	})
	test.each(['risk', 'kind', 'status', 'severity'] as const)(
		'rejects an unknown %s',
		field => {
			const report = reviewReport()
			const invalid =
				field === 'risk'
					? {
							...report,
							planReport: {
								...report.planReport,
								plan: { ...report.planReport.plan, risk: 'unknown' },
							},
						}
					: field === 'status'
						? {
								...report,
								agents: report.agents.map(agent => ({
									...agent,
									status: 'unknown',
								})),
							}
						: {
								...report,
								bugs: report.bugs.map(finding => ({
									...finding,
									[field]: 'unknown',
								})),
							}
			expect(() => roundTrip(invalid)).toThrow()
		}
	)
	test('drops excess keys throughout the report', () => {
		const report = reviewReport()
		expect(
			roundTrip({
				...report,
				token: 'discard',
				bugs: report.bugs.map(finding => ({
					...finding,
					body: 'discard',
					validation: { ...finding.validation, rules: 'discard' },
				})),
				planReport: { ...report.planReport, title: 'discard' },
			})
		).toEqual(report)
	})
})
