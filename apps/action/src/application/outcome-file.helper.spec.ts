import { layer } from '@effect/vitest'
import { REDACTED } from '@mng-review/engine'
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
			report,
		})
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
	test.effect('serializes without masks unchanged', () =>
		Effect.gen(function* () {
			const file = outcomeFile()
			expect(yield* parseOutcomeFile(toOutcomeText(file, []))).toEqual(file)
		})
	)
})
