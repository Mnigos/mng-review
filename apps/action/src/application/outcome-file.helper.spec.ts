import { layer } from '@effect/vitest'
import { getFingerprints, toFingerprint, toFinding } from '@mng-review/domain'
import { REDACTED } from '@mng-review/engine'
import {
	MAX_REPORT_ENTRIES,
	MAX_REPORT_NAME,
	MAX_REPORT_NAMES,
	MAX_REPORT_TEXT,
} from '@mng-review/github'
import { Effect, Layer, Schema } from 'effect'
import { parseOutcomeFile } from '../infrastructure/outcome-file.parser'
import {
	type OutcomeBinding,
	outcomeFileSchema,
	OUTCOME_VERSION,
} from '../infrastructure/outcome-file.schema'
import {
	BINDING_ENV,
	boundReviewReport,
	EVENT,
	outcomeFile,
	recheckProposals,
} from '../shared/mocks/outcome-file.helper'
import { RULES } from '../shared/mocks/review-report.helper'
import {
	getBindingMismatch,
	toOutcomeBinding,
	toOutcomeFile,
	toOutcomeText,
} from './outcome-file.helper'
import type { ShadowOutcome } from './shadow-run.types'

describe('outcome file helpers', () => {
	test('binds to runner variables and the event', () => {
		expect(toOutcomeBinding(EVENT, BINDING_ENV)).toEqual(outcomeFile().binding)
		expect(
			toOutcomeBinding(EVENT, {
				repository: undefined,
				runId: undefined,
				runAttempt: undefined,
				engineCommit: undefined,
			})
		).toEqual({
			...outcomeFile().binding,
			repository: '',
			runId: '',
			runAttempt: '',
			engineCommit: null,
		})
	})
	test('matching bindings have no mismatch', () => {
		const { binding } = outcomeFile()
		expect(getBindingMismatch(binding, { ...binding })).toBeUndefined()
	})
	test.each([
		'repository',
		'runId',
		'runAttempt',
		'engineCommit',
		'pullNumber',
		'baseSha',
		'headSha',
	] as const)('names %s when that field differs', field => {
		const { binding } = outcomeFile()
		const changed: OutcomeBinding = {
			...binding,
			[field]: field === 'pullNumber' ? binding.pullNumber + 1 : 'different',
		}
		expect(getBindingMismatch(changed, binding)).toBe(field)
		expect(getBindingMismatch(binding, changed)).toBe(field)
	})
	test('reports only the first differing field', () => {
		const { binding } = outcomeFile()
		expect(
			getBindingMismatch(
				{ ...binding, headSha: 'different', runAttempt: '2', runId: '456' },
				binding
			)
		).toBe('runId')
	})
	test.each([
		{ status: 'skipped', reason: 'Not a pull request.' },
		{ status: 'invalid-config', source: 'event', reason: 'Invalid event.' },
	] as const satisfies readonly ShadowOutcome[])(
		'produces no file for $status without an event',
		outcome => {
			expect(toOutcomeFile(outcome, undefined, BINDING_ENV)).toBeUndefined()
		}
	)
	test('writes only the reviewed report and binding, omitting the rules and event metadata', () => {
		const report = boundReviewReport()
		expect(
			toOutcomeFile(
				{ status: 'reviewed', event: EVENT, rules: RULES, report },
				undefined,
				BINDING_ENV
			)
		).toEqual({
			version: OUTCOME_VERSION,
			binding: outcomeFile().binding,
			status: 'reviewed',
			report: {
				...report,
				planReport: {
					...report.planReport,
					plan: { ...report.planReport.plan, files: [] },
				},
			},
		})
		expect(report.planReport.plan.files).not.toHaveLength(0)
	})
	test('records when the review started in whole seconds, as GitHub writes times', () => {
		expect(
			toOutcomeFile(
				{
					status: 'reviewed',
					event: EVENT,
					rules: RULES,
					report: boundReviewReport(),
				},
				undefined,
				{ ...BINDING_ENV, startedAt: Date.UTC(2026, 0, 1, 12, 30, 0, 999) }
			)?.startedAt
		).toBe('2026-01-01T12:30:00Z')
	})
	test('turns recheck threads into proposals with only id, fingerprint and reason', () => {
		const recheck = recheckProposals()
		const file = toOutcomeFile(
			{
				status: 'reviewed',
				event: EVENT,
				rules: RULES,
				report: boundReviewReport(),
			},
			recheck,
			BINDING_ENV
		)
		expect(file?.recheck).toEqual({
			checked: recheck.checked,
			tokens: recheck.tokens,
			rejected: recheck.rejected.map(entry => ({
				threadId: entry.thread.id,
				fingerprint: entry.thread.marker.fingerprint,
				reason: entry.reason,
			})),
		})
		expect(JSON.stringify(file?.recheck)).not.toContain('marker')
	})
	test('omits recheck data when no candidate ran and no replacement tokens exist', () => {
		expect(
			toOutcomeFile(
				{
					status: 'reviewed',
					event: EVENT,
					rules: RULES,
					report: boundReviewReport(),
				},
				{ checked: 0, rejected: [], tokens: undefined },
				BINDING_ENV
			)
		).not.toHaveProperty('recheck')
	})
	test('preserves entries when an existing redaction suffix collides with a generated token-map key', () => {
		const report = boundReviewReport()
		const tokens = {
			calls: 1,
			inputTokens: 3,
			cachedInputTokens: 0,
			outputTokens: 2,
			reasoningTokens: 0,
			totalTokens: 5,
		} as const
		const file = {
			...outcomeFile(),
			report: {
				...report,
				tokens: {
					'masked-a': tokens,
					[`${REDACTED} (3)`]: { ...tokens, calls: 2 },
					'masked-b': { ...tokens, calls: 3 },
				},
			},
		}
		const decoded = Schema.decodeUnknownSync(
			Schema.fromJsonString(outcomeFileSchema)
		)(toOutcomeText(file, ['masked-a', 'masked-b']))
		expect(
			Object.values(decoded.report?.tokens ?? {})
				.map(entry => entry.calls)
				.toSorted((a, b) => a - b)
		).toEqual([1, 2, 3])
	})
	test.each(['offline', 'skipped', 'failed', 'invalid-config'] as const)(
		'retains the reason of %s and source only for invalid configuration',
		status => {
			const outcome =
				status === 'invalid-config'
					? {
							status,
							event: EVENT,
							reason: 'Cannot proceed.',
							source: '.mng/review.yml',
						}
					: { status, event: EVENT, reason: 'Cannot proceed.' }
			expect(toOutcomeFile(outcome, undefined, BINDING_ENV)).toEqual({
				version: OUTCOME_VERSION,
				binding: outcomeFile().binding,
				status,
				reason: outcome.reason,
				...(status === 'invalid-config' ? { source: '.mng/review.yml' } : {}),
			})
		}
	)
})

layer(Layer.empty)('toOutcomeText', test => {
	test.effect(
		'keeps the cut title fingerprint when redaction changes the title',
		() =>
			Effect.gen(function* () {
				const report = boundReviewReport()
				const title =
					'A retried write to the store loses data after the first write…'
				const bugs = report.bugs.map(finding => ({
					...finding,
					...toFinding(
						{
							...finding,
							title,
							uncutTitle: `${title.slice(0, -1)} already committed its row`,
						},
						{ agent: 'reviewer', model: 'model-a', kind: 'bug' }
					),
				}))
				const file = { ...outcomeFile(), report: { ...report, bugs } }
				const decoded = yield* parseOutcomeFile(
					toOutcomeText(file, ['retried'])
				)
				const [published] = decoded.report?.bugs ?? []
				expect(published?.title).toBe(title.replace('retried', REDACTED))
				expect(published && getFingerprints(published)).toEqual([
					bugs[0]?.fingerprint,
					toFingerprint({ path: report.bugs[0]?.path ?? '', title }),
				])
			})
	)
	test.effect('caps finding models at the name-list limit', () =>
		Effect.gen(function* () {
			const report = boundReviewReport()
			const models = Array.from(
				{ length: MAX_REPORT_NAMES + 1 },
				(_, index) => `model-${index}`
			)
			const file = {
				...outcomeFile(),
				report: {
					...report,
					bugs: report.bugs.map(finding => ({ ...finding, models })),
				},
			}
			const decoded = yield* parseOutcomeFile(toOutcomeText(file, []))
			expect(decoded.report?.bugs[0]?.models).toHaveLength(MAX_REPORT_NAMES)
			expect(decoded.report?.bugs[0]?.models).toEqual(
				models.slice(0, MAX_REPORT_NAMES)
			)
		})
	)
	test.effect('preserves finding models exactly at the name-list limit', () =>
		Effect.gen(function* () {
			const report = boundReviewReport()
			const models = Array.from(
				{ length: MAX_REPORT_NAMES },
				(_, index) => `model-${index}`
			)
			const file = {
				...outcomeFile(),
				report: {
					...report,
					bugs: report.bugs.map(finding => ({ ...finding, models })),
				},
			}
			const decoded = yield* parseOutcomeFile(toOutcomeText(file, []))
			expect(decoded.report?.bugs[0]?.models).toEqual(models)
		})
	)
	test.effect('caps finding evidence at the report-entry limit', () =>
		Effect.gen(function* () {
			const report = boundReviewReport()
			const evidence = Array.from(
				{ length: MAX_REPORT_ENTRIES + 1 },
				(_, index) => `src/evidence-${index}.ts:1`
			)
			const file = {
				...outcomeFile(),
				report: {
					...report,
					bugs: report.bugs.map(finding => ({ ...finding, evidence })),
				},
			}
			const decoded = yield* parseOutcomeFile(toOutcomeText(file, []))
			expect(decoded.report?.bugs[0]?.evidence).toHaveLength(MAX_REPORT_ENTRIES)
			expect(decoded.report?.bugs[0]?.evidence).toEqual(
				evidence.slice(0, MAX_REPORT_ENTRIES)
			)
		})
	)
	test.effect(
		'replaces masked values in nested strings and token-map keys without losing colliding entries',
		() =>
			Effect.gen(function* () {
				const report = boundReviewReport()
				const url = 'https://llm.example.com/v1'
				const key = 'test-"quoted"\\key'
				const sensitive = `Request ${url} with ${key}`
				const tokens = {
					calls: 1,
					inputTokens: 3,
					cachedInputTokens: 0,
					outputTokens: 2,
					reasoningTokens: 0,
					totalTokens: 5,
				} as const
				const file = {
					...outcomeFile(),
					report: {
						...report,
						endpointError: sensitive,
						bugs: report.bugs.map(finding => ({
							...finding,
							title: sensitive,
						})),
						tokens: { [url]: tokens, [key]: { ...tokens, calls: 2 } },
						tokenSources: {
							[key]: {
								...tokens,
								conversations: 1,
								firstMessageTokens: 3,
								historyTokens: 0,
							},
						},
						planReport: { ...report.planReport, tokens: { [url]: tokens } },
					},
					recheck: {
						checked: 1,
						rejected: [
							{
								threadId: 'thread',
								fingerprint: 'fingerprint',
								reason: sensitive,
							},
						],
						tokens: { [key]: tokens },
					},
				}
				const text = toOutcomeText(file, ['', key, 'llm.example.com', url])
				const decoded = yield* parseOutcomeFile(text)
				expect(decoded.report?.endpointError).toBe(
					`Request ${REDACTED} with ${REDACTED}`
				)
				expect(decoded.report?.bugs[0]?.title).toBe(
					`Request ${REDACTED} with ${REDACTED}`
				)
				expect(decoded.report?.tokens).toEqual({
					[REDACTED]: tokens,
					[`${REDACTED} (2)`]: { ...tokens, calls: 2 },
				})
				expect(decoded.report?.tokenSources).toHaveProperty(REDACTED)
				expect(decoded.report?.planReport.tokens).toEqual({
					[REDACTED]: tokens,
				})
				expect(decoded.recheck).toEqual({
					checked: 1,
					rejected: [
						{
							threadId: 'thread',
							fingerprint: 'fingerprint',
							reason: `Request ${REDACTED} with ${REDACTED}`,
						},
					],
					tokens: { [REDACTED]: tokens },
				})
				for (const value of [
					url,
					key,
					'llm.example.com',
					JSON.stringify(key).slice(1, -1),
				])
					expect(text).not.toContain(value)
			})
	)
	test.effect(
		'redacts model text and names without changing protocol values or paths',
		() =>
			Effect.gen(function* () {
				const report = boundReviewReport()
				const file = {
					...outcomeFile(),
					binding: { ...outcomeFile().binding, repository: 'example/review' },
					report: {
						...report,
						bugs: report.bugs.map(finding => ({
							...finding,
							path: 'src/review.ts',
							title: 'review this',
							models: ['review-model'],
						})),
						agents: report.agents.map(agent => ({
							...agent,
							model: 'review-model',
						})),
						tokens: Object.fromEntries(
							Object.values(report.tokens).map(tokens => [
								'review-model',
								tokens,
							])
						),
						tokenSources: Object.fromEntries(
							Object.values(report.tokens).map(tokens => [
								'review-model',
								{
									...tokens,
									conversations: 1,
									firstMessageTokens: 6,
									historyTokens: 0,
								},
							])
						),
					},
				}
				const decoded = yield* parseOutcomeFile(toOutcomeText(file, ['review']))
				expect(decoded.status).toBe('reviewed')
				expect(decoded.binding).toEqual(file.binding)
				expect(
					getBindingMismatch(decoded.binding, file.binding)
				).toBeUndefined()
				expect(decoded.report?.bugs).toEqual(
					file.report.bugs.map(finding => ({
						...finding,
						title: `${REDACTED} this`,
						models: [`${REDACTED}-model`],
					}))
				)
				expect(decoded.report?.agents).toEqual(
					file.report.agents.map(agent => ({
						...agent,
						title: agent.title.replaceAll('review', REDACTED),
						model: `${REDACTED}-model`,
					}))
				)
				expect(decoded.report?.tokens).toEqual(
					Object.fromEntries(
						Object.values(file.report.tokens).map(tokens => [
							`${REDACTED}-model`,
							tokens,
						])
					)
				)
				expect(decoded.report?.tokenSources).toEqual(
					Object.fromEntries(
						Object.values(file.report.tokenSources).map(tokens => [
							`${REDACTED}-model`,
							tokens,
						])
					)
				)
				expect(decoded.report?.planReport).toEqual({
					...report.planReport,
					plan: {
						...report.planReport.plan,
						runs: report.planReport.plan.runs.map(run => ({
							...run,
							title: run.title.replaceAll('review', REDACTED),
						})),
					},
				})
			})
	)
	test.effect(
		'bounds long model output and recheck reasons while preserving other findings',
		() =>
			Effect.gen(function* () {
				const report = boundReviewReport()
				const suggestion = 's'.repeat(25_000)
				const reason = 'r'.repeat(25_000)
				const model = 'm'.repeat(300)
				const evidence = Array.from({ length: 600 }, (_, index) =>
					index === 0 ? 'e'.repeat(25_000) : `src/evidence-${index}.ts:1`
				)
				const file = {
					...outcomeFile(),
					report: {
						...report,
						bugs: report.bugs.map((finding, index) =>
							index === 0
								? {
										...finding,
										suggestion,
										evidence,
										models: [model],
									}
								: finding
						),
						agents: report.agents.map((agent, index) =>
							index === 0 ? { ...agent, model } : agent
						),
					},
					recheck: {
						checked: 1,
						rejected: [
							{ threadId: 'thread', fingerprint: 'fingerprint', reason },
						],
						tokens: report.tokens,
					},
				}
				const decoded = yield* parseOutcomeFile(toOutcomeText(file, []))
				expect(decoded.report?.bugs[0]?.suggestion).toBe(
					suggestion.slice(0, MAX_REPORT_TEXT)
				)
				expect(decoded.report?.bugs[0]?.evidence).toEqual(
					evidence
						.slice(0, MAX_REPORT_ENTRIES)
						.map(entry => entry.slice(0, MAX_REPORT_TEXT))
				)
				expect(decoded.report?.bugs[0]?.models).toEqual([
					model.slice(0, MAX_REPORT_NAME),
				])
				expect(decoded.report?.agents[0]?.model).toBe(
					model.slice(0, MAX_REPORT_NAME)
				)
				expect(decoded.recheck?.rejected).toEqual([
					{
						threadId: 'thread',
						fingerprint: 'fingerprint',
						reason: reason.slice(0, MAX_REPORT_TEXT),
					},
				])
				expect(decoded.report?.bugs.slice(1)).toEqual(report.bugs.slice(1))
				expect(decoded.report?.nits).toEqual(report.nits)
				expect(decoded.report?.rejected).toEqual(report.rejected)
			})
	)
	test.effect(
		'preserves a deleted changed-file name and old name containing backslashes',
		() =>
			Effect.gen(function* () {
				const report = boundReviewReport()
				const files = report.planReport.change.files.map(file => ({
					...file,
					path: 'src/removed\\file.ts',
					oldPath: 'src/old\\file.ts',
					status: 'deleted' as const,
				}))
				const decoded = yield* parseOutcomeFile(
					toOutcomeText(
						{
							...outcomeFile(),
							report: {
								...report,
								planReport: {
									...report.planReport,
									change: { ...report.planReport.change, files },
								},
							},
						},
						[]
					)
				)
				expect(decoded.report?.planReport.change.files).toEqual(files)
				expect(decoded.report?.bugs).toEqual(report.bugs)
			})
	)
	test.effect('still rejects a finding path containing a backslash', () =>
		Effect.gen(function* () {
			const report = boundReviewReport()
			const error = yield* parseOutcomeFile(
				toOutcomeText(
					{
						...outcomeFile(),
						report: {
							...report,
							bugs: report.bugs.map(finding => ({
								...finding,
								path: 'src/review\\file.ts',
							})),
						},
					},
					[]
				)
			).pipe(Effect.flip)
			expect(error._tag).toBe('OutcomeFileError')
			expect(error.message).toContain('must be a repository-relative path')
		})
	)
	test.effect('round trips a report with 5,001 changed files', () =>
		Effect.gen(function* () {
			const report = boundReviewReport()
			const files = Array.from({ length: 5001 }, (_, index) => ({
				path: `src/file-${index}.ts`,
				status: 'modified' as const,
				additions: 1,
				deletions: 1,
				binary: false,
				sizeBytes: 10,
			}))
			const file = toOutcomeFile(
				{
					status: 'reviewed',
					event: EVENT,
					rules: RULES,
					report: {
						...report,
						planReport: {
							...report.planReport,
							change: { ...report.planReport.change, files },
							plan: { ...report.planReport.plan, files },
						},
					},
				},
				undefined,
				BINDING_ENV
			)
			expect(file).toBeDefined()
			if (file === undefined) return
			const decoded = yield* parseOutcomeFile(toOutcomeText(file, []))
			expect(decoded.report?.planReport.change.files).toEqual(files)
			expect(decoded.report?.planReport.plan.files).toEqual([])
			expect(decoded.report?.bugs).toEqual(report.bugs)
		})
	)
	test.effect('serializes without masks unchanged', () =>
		Effect.gen(function* () {
			const file = outcomeFile()
			expect(yield* parseOutcomeFile(toOutcomeText(file, []))).toEqual(file)
		})
	)
})
