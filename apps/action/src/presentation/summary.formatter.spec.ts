import {
	MECHANICAL_CONDITIONS,
	MECHANICAL_MAX_NET_SHARE,
	MECHANICAL_MIN_FILES,
	MECHANICAL_MIN_SMALL_SHARE,
	MECHANICAL_REWRITE_MIN_LINES,
} from '@mng-review/domain'
import { escapeMarkdown } from '@mng-review/github'
import type {
	PullRequestEvent,
	ShadowOutcome,
} from '../application/shadow-run.types'
import { BASE_SHA, HEAD_SHA } from '../shared/mocks/pull-request-event.helper'
import {
	deepReviewReport,
	RULES,
	reviewReport,
} from '../shared/mocks/review-report.helper'
import {
	formatLogLine,
	formatPublishLogLine,
	formatSweepLine,
	formatSweepSummary,
	formatPublishSummary,
	formatSummary,
	SUMMARY_TITLE,
	toVerdictLine,
	type SummaryContext,
} from './summary.formatter'

const EVENT = {
	number: 17,
	baseSha: BASE_SHA,
	headSha: HEAD_SHA,
	pr: { labels: [], draft: false, fork: false, trigger: 'auto' },
} as const satisfies PullRequestEvent
const CONTEXT = {
	engineCommit: '1234567890abcdef',
} as const satisfies SummaryContext
const MALICIOUS = '![x](https://evil.example/a.png) <img src=x> | col'
const OUTCOMES = [
	{
		outcome: { status: 'skipped', reason: 'draft pull request' },
		summary: 'Skipped: draft pull request.',
		log: 'mng-review: skipped: draft pull request',
	},
	{
		outcome: { status: 'offline', reason: 'unreachable', event: EVENT },
		summary:
			'Reviewer offline: unreachable. Nothing was reviewed; the job passes.',
		log: 'mng-review: reviewer offline: unreachable',
	},
	{
		outcome: {
			status: 'invalid-config',
			source: '.mng/review.yml',
			reason: 'unknown setting',
		},
		summary: '**Invalid configuration** in `.mng/review.yml`: unknown setting',
		log: 'mng-review: invalid configuration: .mng/review.yml: unknown setting',
	},
	{
		outcome: { status: 'failed', reason: 'missing base commit', event: EVENT },
		summary: '**Failed:** missing base commit',
		log: 'mng-review: failed: missing base commit',
	},
] as const satisfies readonly {
	readonly outcome: ShadowOutcome
	readonly summary: string
	readonly log: string
}[]

describe('formatLogLine', () => {
	for (const command of [
		'::add-mask::x',
		'::error::failure',
		':::error::',
		'::stop-commands::t',
		'##[error]',
		'\u001B[31merror\u001B[0m',
	]) {
		const reason = `failure\r\n${command}`
		for (const entry of OUTCOMES)
			test(`neutralizes ${JSON.stringify(command)} in ${entry.outcome.status} reasons`, () => {
				const line = formatLogLine({ ...entry.outcome, reason })
				expect(line).toContain('failure ')
				expect(line).not.toMatch(/\p{Cc}/u)
				expect(line).not.toContain('::')
				expect(line).not.toContain('##[')
			})
		test(`neutralizes ${JSON.stringify(command)} in reviewed endpoint errors`, () => {
			const line = formatLogLine({
				status: 'reviewed',
				rules: RULES,
				event: EVENT,
				report: { ...reviewReport(), endpointError: reason },
			})
			expect(line).toContain('incomplete, the model endpoint failed: failure ')
			expect(line).not.toMatch(/\p{Cc}/u)
			expect(line).not.toContain('::')
			expect(line).not.toContain('##[')
		})
		test(`neutralizes ${JSON.stringify(command)} in reviewed skip reasons`, () => {
			const report = reviewReport()
			const line = formatLogLine({
				status: 'reviewed',
				rules: RULES,
				event: EVENT,
				report: {
					...report,
					planReport: {
						...report.planReport,
						plan: { ...report.planReport.plan, skippedRun: reason },
					},
				},
			})
			expect(line).toContain('mng-review: skipped: failure ')
			expect(line).not.toMatch(/\p{Cc}/u)
			expect(line).not.toContain('::')
			expect(line).not.toContain('##[')
		})
	}
})

describe('formatSummary', () => {
	for (const entry of OUTCOMES)
		test(`formats ${entry.outcome.status} outcome and log`, () => {
			const text = formatSummary(entry.outcome, CONTEXT)
			expect(text).toContain(SUMMARY_TITLE)
			expect(text).toContain(entry.summary)
			expect(text).toContain('Engine `12345678`.')
			expect(text).not.toContain(CONTEXT.engineCommit)
			expect(text).toContain(
				'Shadow mode: nothing is posted to the pull request.'
			)
			expect(formatLogLine(entry.outcome)).toBe(entry.log)
		})
	test('reviewed outcome includes verdict, risk, agent reasons, tokens, wall time and shortened commits', () => {
		const report = reviewReport()
		const text = formatSummary(
			{ status: 'reviewed', rules: RULES, event: EVENT, report },
			CONTEXT
		)
		expect(text).toContain(
			'**Verdict, not posted:** needs fixes, 1 bug\\(s\\) at or above the severity floor'
		)
		expect(text).toContain(
			'Pull request #17, base `aaaaaaaa`, head `bbbbbbbb`. Rules from the base commit.'
		)
		expect(text).toContain('Risk **normal**')
		expect(text).toContain(
			'| reviewer | always | model-b \\(for model-a\\) high | ok | 2 | 3 | 1.2 s |'
		)
		expect(text).toContain('| model-b | 10 | 6 | 0 | 4 | 2 |')
		expect(text).toContain('Wall time 1.2 s.')
		expect(text).toContain('### Did not finish')
		expect(text).toContain('model model-a dropped: rate limited \\(429\\)')
		expect(
			formatLogLine({ status: 'reviewed', rules: RULES, event: EVENT, report })
		).toBe(`mng-review: ${toVerdictLine(report)}`)
	})
	test.each(['planned', 'reversed'])(
		'matches deep reviewer rows to their model with reports in %s order',
		order => {
			const report = deepReviewReport()
			const text = formatSummary(
				{
					status: 'reviewed',
					rules: RULES,
					event: EVENT,
					report: {
						...report,
						agents:
							order === 'planned'
								? report.agents
								: [...report.agents].toReversed(),
					},
				},
				CONTEXT
			)
			expect(text).toContain('Depth deep (config)')
			expect(
				text.split('\n').filter(line => line.startsWith('| reviewer |'))
			).toEqual([
				'| reviewer | always | model-a high | ok | 1 | 3 | 1.2 s |',
				'| reviewer | always | model-b high | ok | 2 | 4 | 2.4 s |',
			])
		}
	)
	test.each(['planned', 'reversed'])(
		'matches a dropped reviewer model to its fallback with reports in %s order',
		order => {
			const report = deepReviewReport()
			const agents = report.agents.map(agent => ({
				...agent,
				model: 'model-a',
				...(agent.model === 'model-b' ? { fellBackFrom: 'model-b' } : {}),
			}))
			const text = formatSummary(
				{
					status: 'reviewed',
					rules: RULES,
					event: EVENT,
					report: {
						...report,
						agents: order === 'planned' ? agents : [...agents].toReversed(),
						droppedModels: [{ model: 'model-b', reason: 'rate limited (429)' }],
					},
				},
				CONTEXT
			)
			expect(
				text.split('\n').filter(line => line.startsWith('| reviewer |'))
			).toEqual([
				'| reviewer | always | model-a high | ok | 1 | 3 | 1.2 s |',
				'| reviewer | always | model-a \\(for model-b\\) high | ok | 2 | 4 | 2.4 s |',
			])
			expect(text).toContain('model model-b dropped: rate limited \\(429\\)')
		}
	)
	test('shows planned reviewer runs without reports as not run', () => {
		const report = deepReviewReport()
		const text = formatSummary(
			{
				status: 'reviewed',
				rules: RULES,
				event: EVENT,
				report: { ...report, agents: [] },
			},
			CONTEXT
		)
		expect(
			text.split('\n').filter(line => line.startsWith('| reviewer |'))
		).toEqual([
			'| reviewer | always | model-a high | not run | 0 | 0 |  |',
			'| reviewer | always | model-b high | not run | 0 | 0 |  |',
		])
	})
	test('escapes every model and rules text in plan, skipped agents, failures and token table', () => {
		const fixture = reviewReport()
		const [planned] = fixture.planReport.plan.runs
		expect(planned).toBeDefined()
		if (!planned) return
		const report = {
			...fixture,
			agents: [
				{
					...fixture.agents[0],
					name: MALICIOUS,
					title: MALICIOUS,
					kind: 'bug',
					effort: 'high',
					status: 'failed',
					model: MALICIOUS,
					fellBackFrom: MALICIOUS,
					toolCalls: 0,
					findings: 0,
					malformed: 0,
					wallMillis: 0,
					error: MALICIOUS,
				} as const,
			],
			tokens: {
				[MALICIOUS]: {
					calls: 1,
					inputTokens: 1,
					cachedInputTokens: 0,
					outputTokens: 1,
					reasoningTokens: 0,
					totalTokens: 2,
				},
			},
			droppedModels: [{ model: MALICIOUS, reason: MALICIOUS }],
			incomplete: { reason: MALICIOUS, unfinished: [MALICIOUS] },
			planReport: {
				...fixture.planReport,
				plan: {
					...fixture.planReport.plan,
					depthSource: MALICIOUS,
					riskPathHits: [MALICIOUS],
					router: { status: 'failed', detail: MALICIOUS, added: [] } as const,
					runs: [
						{
							...planned,
							name: MALICIOUS,
							model: MALICIOUS,
							selectedBy: 'router',
							reason: MALICIOUS,
						} as const,
					],
					skips: [{ name: MALICIOUS, title: MALICIOUS, reason: MALICIOUS }],
				},
			},
		}
		const text = formatSummary(
			{ status: 'reviewed', rules: RULES, event: EVENT, report },
			CONTEXT
		)
		expect(text).not.toContain('![')
		expect(text).not.toMatch(/(?<!\\)<img/u)
		expect(text).toContain(`router: ${escapeMarkdown(MALICIOUS)}`)
		expect(text).toContain('### Agents skipped (1)')
		for (const row of text
			.split('\n')
			.filter(line => line.startsWith('|') && line.includes('evil.example')))
			expect(row.match(/(?<!\\)\|/gu)?.length).toBe(
				row.includes('high') ? 8 : 7
			)
	})
	for (const entry of OUTCOMES)
		test(`escapes the ${entry.outcome.status} reason`, () => {
			const text = formatSummary(
				{ ...entry.outcome, reason: MALICIOUS },
				{ engineCommit: undefined }
			)
			expect(text).toContain(escapeMarkdown(MALICIOUS))
			expect(text).not.toContain('![')
			expect(text).not.toMatch(/(?<!\\)<img/u)
			expect(text).toContain('Engine commit unknown.')
		})
	test('escapes endpoint errors in a reviewed summary', () => {
		const text = formatSummary(
			{
				status: 'reviewed',
				rules: RULES,
				event: EVENT,
				report: { ...reviewReport(), endpointError: MALICIOUS },
			},
			CONTEXT
		)
		expect(text).toContain(
			`incomplete, the model endpoint failed: ${escapeMarkdown(MALICIOUS)}`
		)
		expect(text).not.toContain('![')
		expect(text).not.toMatch(/(?<!\\)<img/u)
	})
	test('names path rules as the reason for a selected agent', () => {
		const report = reviewReport()
		const text = formatSummary(
			{
				status: 'reviewed',
				rules: RULES,
				event: EVENT,
				report: {
					...report,
					planReport: {
						...report.planReport,
						plan: {
							...report.planReport.plan,
							runs: report.planReport.plan.runs.map(run => ({
								...run,
								selectedBy: 'paths',
							})),
						},
					},
				},
			},
			CONTEXT
		)
		expect(text).toContain('| reviewer | path rules |')
	})

	test('skipped and empty plans omit findings and timing', () => {
		const fixture = reviewReport()
		for (const skippedRun of ['label storage is in skip.labels', undefined]) {
			const report = {
				...fixture,
				planReport: {
					...fixture.planReport,
					plan: {
						...fixture.planReport.plan,
						runs: [],
						...(skippedRun === undefined ? {} : { skippedRun }),
					},
				},
			}
			const text = formatSummary(
				{ status: 'reviewed', rules: RULES, event: EVENT, report },
				CONTEXT
			)
			expect(text).toContain(skippedRun ?? 'nothing to review')
			expect(text).not.toContain('### Bugs')
			expect(text).not.toContain('Wall time')
		}
	})
})

describe('toVerdictLine', () => {
	test('ready with no blocking bugs and every agent finished', () => {
		const report = reviewReport()
		expect(
			toVerdictLine({
				...report,
				blocking: false,
				bugs: [],
				agents: report.agents.filter(agent => agent.status === 'ok'),
			})
		).toBe('ready, no bug at or above the severity floor')
	})
	test('a failed agent makes a run without blocking bugs incomplete', () => {
		const report = reviewReport()
		expect(
			toVerdictLine({
				...report,
				blocking: false,
				bugs: [],
				endpointError: undefined,
			})
		).toMatch(/^incomplete, \d+ agent\(s\) did not finish/u)
	})
	test('incomplete reports keep the verdict and name the incomplete run', () => {
		const report = {
			...reviewReport(),
			incomplete: { reason: 'budget spent', unfinished: ['reviewer'] },
		}
		expect(toVerdictLine(report)).toContain('; the run is incomplete')
		expect(
			formatSummary(
				{ status: 'reviewed', rules: RULES, event: EVENT, report },
				CONTEXT
			)
		).toContain('- reviewer: budget spent')
	})
	test('endpoint error takes precedence over a blocking finding', () => {
		const report = { ...reviewReport(), endpointError: 'no model available' }
		expect(toVerdictLine(report)).toBe(
			'incomplete, the model endpoint failed: no model available'
		)
		expect(
			formatSummary(
				{ status: 'reviewed', rules: RULES, event: EVENT, report },
				CONTEXT
			)
		).toContain('incomplete, the model endpoint failed: no model available')
	})
})

for (const failed of [[], MECHANICAL_CONDITIONS] as const)
	test(`summary prints measured values and limits before mechanical failures ${failed.join(', ')}`, () => {
		const fixture = reviewReport()
		const shape = {
			files: failed.length ? MECHANICAL_MIN_FILES - 1 : MECHANICAL_MIN_FILES,
			smallShare: failed.length ? 0.594 : MECHANICAL_MIN_SMALL_SHARE,
			netShare: failed.length ? 0.256 : MECHANICAL_MAX_NET_SHARE,
			riskyRewrites: failed.length ? ['src/billing/charge.ts'] : [],
			failed,
		}
		const report = {
			...fixture,
			planReport: {
				...fixture.planReport,
				plan: {
					...fixture.planReport.plan,
					riskPathHits: ['src/billing/charge.ts'],
					shape,
				},
			},
		}
		const text = formatSummary(
			{ status: 'reviewed', rules: RULES, event: EVENT, report },
			CONTEXT
		)
		const riskLine = text.split('\n').find(line => line.startsWith('Risk **'))
		const verdict = failed.length
			? `not mechanical, failed: ${failed.join(', ')}`
			: 'mechanical change'
		expect(riskLine).toContain(
			`; ${shape.files} files (mechanical needs ${MECHANICAL_MIN_FILES}), ${failed.length ? '59%' : `${MECHANICAL_MIN_SMALL_SHARE * 100}%`} small edits (needs ${MECHANICAL_MIN_SMALL_SHARE * 100}%), lines ${failed.length ? '26%' : `${MECHANICAL_MAX_NET_SHARE * 100}%`} apart (at most ${MECHANICAL_MAX_NET_SHARE * 100}%), ${shape.riskyRewrites.length} risky rewrite(s) of ${MECHANICAL_REWRITE_MIN_LINES}+ lines: ${verdict}`
		)
	})

test.each([false, true])(
	'summary omits shape annotation when risk paths are absent=%s',
	absentRiskPaths => {
		const fixture = reviewReport()
		const shape = {
			files: 1,
			smallShare: 1,
			netShare: 0,
			riskyRewrites: [],
			failed: [],
		}
		const report = {
			...fixture,
			planReport: {
				...fixture.planReport,
				plan: {
					...fixture.planReport.plan,
					riskPathHits: absentRiskPaths ? [] : ['src/billing/charge.ts'],
					shape: absentRiskPaths ? shape : undefined,
				},
			},
		}
		const text = formatSummary(
			{ status: 'reviewed', rules: RULES, event: EVENT, report },
			CONTEXT
		)
		expect(text).not.toContain('mechanical change')
		expect(text).not.toContain('not mechanical')
		expect(text).not.toContain('files (mechanical needs')
		expect(text).not.toContain('small edits (needs')
		expect(text).not.toContain('apart (at most')
		expect(text).not.toContain('risky rewrite(s)')
	}
)

test.each(['published', 'failed', 'status-only', 'not-published'] as const)(
	'summary includes %s publish report and mode',
	status => {
		const publish =
			status === 'published'
				? ({
						status,
						checks: { checks: 2, status: true },
						result: {
							verdict: 'ready',
							openBugs: 0,
							onLine: 1,
							onFile: 2,
							inSummary: 3,
							unposted: 4,
							repeated: 5,
							dismissed: 7,
							rechecked: 8,
							resolved: 3,
							run: 6,
							finished: true,
							answered: {},
							waiting: 0,
							label: 'none',
							cleanup: 'none',
						},
					} as const)
				: status === 'status-only'
					? { status, reason: MALICIOUS, posted: false }
					: { status, reason: MALICIOUS }
		const text = formatPublishSummary(publish, CONTEXT.engineCommit)
		expect(text).toContain('Publish mode:')
		expect(text).not.toContain('Shadow mode:')
		if (status === 'published') {
			expect(text).toContain(
				'3 of 8 rechecked thread\\(s\\) resolved; 2 check run\\(s\\), status set'
			)
			expect(text).toContain(
				'1 on lines, 2 on files, 3 in the summary, 4 not posted; 5 already had a thread, 7 found again under resolved threads'
			)
		}
		if (status === 'failed' || status === 'not-published')
			expect(text).toContain(escapeMarkdown(MALICIOUS))
		if (status === 'status-only')
			expect(text).toContain(
				'marked the existing summary unfinished; the reviewer was offline'
			)
	}
)

test.each([
	'::error file=x::injected\n::warning::next',
	'\r##[error]injected\u202E\u2028::stop-commands::token',
])('publish log cannot emit workflow commands from %s', reason => {
	const text = formatPublishLogLine({ status: 'failed', reason })
	expect(text).toMatch(/^mng-review: publishing failed:/u)
	expect(text).not.toContain('::')
	expect(text).not.toContain('##[')
	expect(text).not.toMatch(/[\r\n\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u)
})

describe('sweep formatters', () => {
	test('reports checked, updated and failed pulls including a no-op sweep', () => {
		expect(formatSweepLine({ checked: 4, updated: 2, failed: 1 })).toBe(
			'status sweep: 4 pull request(s) carry the status, 2 updated, 1 failed'
		)
		expect(formatSweepLine({ checked: 0, updated: 0, failed: 0 })).toBe(
			'status sweep: 0 pull request(s) carry the status, 0 updated, 0 failed'
		)
	})
	test('sweep summaries escape supplied text', () => {
		expect(formatSweepSummary(MALICIOUS)).toContain(escapeMarkdown(MALICIOUS))
		expect(formatSweepSummary(MALICIOUS)).not.toContain('![')
		expect(
			formatSweepSummary(formatSweepLine({ checked: 2, updated: 1, failed: 0 }))
		).toContain('2 pull request')
	})
})

test.each(['none', 'minimized', 'deleted', 'kept'] as const)(
	'publish log shows cleanup=%s',
	cleanup => {
		expect(
			formatPublishLogLine({
				status: 'published',
				checks: { checks: 0, status: true },
				result: {
					verdict: 'ready',
					openBugs: 0,
					onLine: 0,
					onFile: 0,
					inSummary: 0,
					unposted: 0,
					repeated: 0,
					dismissed: 0,
					rechecked: 0,
					resolved: 0,
					answered: {},
					waiting: 0,
					label: 'none',
					run: 1,
					finished: true,
					cleanup,
				},
			})
		).toContain(`earlier summaries: ${cleanup}`)
	}
)

test.each(['added', 'removed', 'failed', 'none'] as const)(
	'job summary reports the waiting count and label outcome %s',
	label => {
		const publish = {
			status: 'published',
			checks: { checks: 0, status: true },
			result: {
				verdict: 'needs owner',
				openBugs: 0,
				onLine: 0,
				onFile: 0,
				inSummary: 0,
				unposted: 0,
				repeated: 0,
				dismissed: 0,
				rechecked: 0,
				resolved: 0,
				answered: {},
				waiting: label === 'removed' ? 0 : 2,
				label,
				run: 1,
				finished: true,
				cleanup: 'none',
			},
		} as const
		const line = `${publish.result.waiting} thread(s) wait for the owner, label ${label}`
		expect(formatPublishSummary(publish, CONTEXT.engineCommit)).toContain(
			escapeMarkdown(line)
		)
		expect(formatPublishLogLine(publish)).toContain(line)
	}
)
