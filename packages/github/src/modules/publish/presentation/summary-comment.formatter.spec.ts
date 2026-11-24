import { SEVERITIES } from '@mng-review/domain'
import { agent, config } from '../../../shared/mocks/domain-test.helper'
import {
	HOSTILE_TEXT,
	toTextOutsideCode,
} from '../../../shared/mocks/hostile-text.helper'
import {
	bug,
	botThread,
	LINKS,
	report,
	SUMMARY_MARKER,
} from '../../../shared/mocks/publish-test.helper'
import { escapeMarkdown } from '../../../utils/markdown.util'
import { parseSummaryMarker } from '../domain/publish-marker.parser'
import { planPublish } from '../domain/publish-plan.helper'
import {
	SEVERITY_MARKERS,
	UNVERIFIED_MARKER,
} from '../domain/publish.constants'
import type { ThreadPlace } from '../domain/publish.types'
import {
	formatSummaryComment,
	toUnfinishedSummary,
	formatStatusComment,
	MAX_SUMMARY_CHARS,
	type SummaryInput,
} from './summary-comment.formatter'
import { toMarkerComment } from './thread-comment.formatter'

/** Summary sections all receive the same hostile model text. */
function input(): SummaryInput {
	const fixture = report()
	const finding = bug({
		title: HOSTILE_TEXT,
		trigger: HOSTILE_TEXT,
		impact: HOSTILE_TEXT,
		suggestion: HOSTILE_TEXT,
		agents: [HOSTILE_TEXT],
		evidence: [HOSTILE_TEXT],
		validation: {
			status: 'unverified',
			severity: 'high',
			premise: HOSTILE_TEXT,
			reason: HOSTILE_TEXT,
			evidence: [],
			model: HOSTILE_TEXT,
		},
	})
	return {
		report: {
			...fixture,
			bugs: [finding],
			rejected: [
				{ ...finding, reason: HOSTILE_TEXT, validatedBy: HOSTILE_TEXT },
			],
			planReport: {
				...fixture.planReport,
				plan: {
					...fixture.planReport.plan,
					riskSource: 'router',
					router: {
						status: 'ok',
						risk: 'risky',
						added: [],
						signals: [
							{ category: 'access', path: HOSTILE_TEXT, reason: HOSTILE_TEXT },
						],
					},
					runs: fixture.planReport.plan.runs.map(run => ({
						...run,
						name: HOSTILE_TEXT,
						model: HOSTILE_TEXT,
						selectedBy: 'router',
						reason: HOSTILE_TEXT,
					})),
					skips: [
						{ name: HOSTILE_TEXT, title: HOSTILE_TEXT, reason: HOSTILE_TEXT },
					],
				},
			},
			tokens: {
				[HOSTILE_TEXT]: {
					calls: 1,
					inputTokens: 1000,
					cachedInputTokens: 0,
					outputTokens: 0,
					reasoningTokens: 0,
					totalTokens: 1000,
				},
			},
		},
		plan: {
			threads: [{ finding, kind: 'unverified', place: 'summary' }],
			repeated: [],
			dismissed: [],
			summaryNits: [],
		},
		verdict: 'ready',
		openBugs: 0,
		marker: SUMMARY_MARKER,
		maxRuns: 5,
		links: LINKS,
		resolved: [],
		tokens: {
			[HOSTILE_TEXT]: {
				calls: 1,
				inputTokens: 1000,
				cachedInputTokens: 0,
				outputTokens: 0,
				reasoningTokens: 0,
				totalTokens: 1000,
			},
		},
	}
}

describe('formatSummaryComment', () => {
	test('metadata summary nits appear only about the pull request while code nits keep their location', () => {
		const fixture = input()
		const metadata = bug({
			kind: 'nit',
			placement: 'summary',
			agents: ['metadata'],
			title: 'Clarify the pull request scope',
			path: 'made-up.ts',
			line: 999,
			evidence: [],
		})
		const diff = bug({
			kind: 'nit',
			placement: 'summary',
			agents: ['diff'],
			title: 'Use a clearer local name',
		})
		const reviewReport = {
			...fixture.report,
			bugs: [],
			nits: [metadata, diff],
			rejected: [],
		}
		const plan = planPublish(
			{
				outcome: reviewReport,
				config: config(),
				agents: new Map([
					['metadata', agent('metadata', { input: 'metadata' })],
					['diff', agent('diff', { input: 'incremental' })],
				]),
			},
			{ threads: [], lines: new Map(), changedPlaces: new Set() }
		)
		const text = formatSummaryComment({
			...fixture,
			report: reviewReport,
			plan,
		})
		expect(text).toContain(
			`About the pull request (1):\n\n<details><summary>Nit finding 1</summary>\n\n- **Nit** ${metadata.title}\n`
		)
		expect(text).not.toContain(`${metadata.path}:${metadata.line}`)
		expect(text).toContain(
			`Nits not posted inline (1):\n\n- **Nit** \`${diff.path}:${diff.line}\` ${diff.title}`
		)
		const [, nitsSection] = text.split('Nits not posted inline (1):')
		expect(nitsSection).not.toContain(metadata.title)
		expect(toTextOutsideCode(text).split(metadata.title)).toHaveLength(2)
	})

	test('a lone metadata summary nit has no nits list or code location', () => {
		const fixture = input()
		const finding = bug({
			kind: 'nit',
			placement: 'summary',
			agents: ['metadata'],
			evidence: [],
		})
		const reviewReport = {
			...fixture.report,
			bugs: [],
			nits: [finding],
			rejected: [],
		}
		const text = formatSummaryComment({
			...fixture,
			report: reviewReport,
			plan: planPublish(
				{
					outcome: reviewReport,
					config: config(),
					agents: new Map([
						['metadata', agent('metadata', { input: 'metadata' })],
					]),
				},
				{ threads: [], lines: new Map(), changedPlaces: new Set() }
			),
		})
		expect(text).toContain('About the pull request (1):')
		expect(text).not.toContain(`${finding.path}:${finding.line}`)
		expect(text).not.toContain('Nits not posted inline')
	})
	test.each(['bug', 'unverified', 'nit'] as const)(
		'lists a pull request %s collapsed without a code location',
		kind => {
			const fixture = input()
			const finding = bug({
				title: HOSTILE_TEXT,
				agents: ['metadata'],
				kind: kind === 'nit' ? 'nit' : 'bug',
			})
			const text = formatSummaryComment({
				...fixture,
				report: {
					...fixture.report,
					bugs: kind === 'nit' ? [] : [finding],
					nits: kind === 'nit' ? [finding] : [],
					rejected: [],
				},
				plan: {
					threads: [{ finding, kind, place: 'pull_request' }],
					repeated: [],
					dismissed: [],
					summaryNits: [],
				},
			})
			const name =
				kind === 'bug' ? 'High' : kind === 'nit' ? 'Nit' : 'Unverified, high'
			const marker =
				kind === 'bug'
					? `${SEVERITY_MARKERS.high} `
					: kind === 'nit'
						? ''
						: `${UNVERIFIED_MARKER} `
			expect(text).toContain(
				`About the pull request (1):\n\n<details><summary>${marker}${name} finding 1</summary>\n\n- ${marker}**${name}** ${escapeMarkdown(finding.title)}\n`
			)
			expect(text).toContain(finding.trigger)
			expect(text).toContain(finding.impact)
			expect(text).toContain('</details>')
			expect(
				text
					.split('\n')
					.find(
						line =>
							line.startsWith('- ') &&
							line.includes(escapeMarkdown(finding.title))
					)
			).not.toContain(`${finding.path}:${finding.line}`)
			expect(text).not.toContain('New threads')
			expect(text).not.toContain('Not in the diff')
		}
	)

	test('lists bot closures separately with escaped reasons', () => {
		const text = formatSummaryComment({
			...input(),
			resolved: [{ thread: botThread(), reason: HOSTILE_TEXT }],
		})
		expect(text).toContain(
			'Closed by this run, no longer found at the head (1):'
		)
		expect(text).toContain(escapeMarkdown(HOSTILE_TEXT))
		expect(text).not.toContain('Resolved by this run')
	})
	test('lists dismissed findings as nonblocking and escapes their titles', () => {
		const fixture = input()
		const finding = bug({ title: HOSTILE_TEXT, placement: 'summary' })
		const text = formatSummaryComment({
			...fixture,
			report: { ...fixture.report, bugs: [finding], rejected: [] },
			plan: {
				threads: [],
				repeated: [],
				dismissed: [{ finding, kind: 'bug' }],
				summaryNits: [],
			},
		})
		expect(text).toContain(
			`Found again under threads resolved without a code change, not blocking (1):\n\n- ${SEVERITY_MARKERS.high} **High** \`src/store.ts:10\` ${escapeMarkdown(HOSTILE_TEXT)}`
		)
		expect(text).not.toContain('Below the severity floor')
		expect(text).not.toContain('already have a thread')
		expect(text).toContain('**Verdict: ready**')
	})
	test.each([false, true])(
		'lists bugs below their severity floor, unverified=%s',
		unverified => {
			const fixture = input()
			const finding = bug({
				severity: 'medium',
				placement: 'summary',
				agents: ['specialist'],
				validation: unverified
					? {
							status: 'unverified',
							severity: 'medium',
							reason: 'Missing contract',
							premise: 'Dependency behavior',
							evidence: [],
							model: 'validator',
						}
					: undefined,
			})
			const reviewReport = { ...fixture.report, bugs: [finding], rejected: [] }
			const plan = planPublish(
				{
					outcome: reviewReport,
					config: config({ comments: { min_severity: 'low' } }),
					agents: new Map([
						[
							'specialist',
							agent('specialist', { comments: { min_severity: 'high' } }),
						],
					]),
				},
				{ threads: [], lines: new Map(), changedPlaces: new Set() }
			)
			const text = formatSummaryComment({
				...fixture,
				report: reviewReport,
				plan,
			})
			expect(plan.threads).toEqual([])
			expect(text).toContain(
				`Below the severity floor (1):\n\n- ${unverified ? `${UNVERIFIED_MARKER} **Unverified, medium**` : `${SEVERITY_MARKERS.medium} **Medium**`} \`src/store.ts:10\` ${finding.title}`
			)
			expect(text).not.toContain('New threads')
		}
	)
	test.each([
		'line',
		'file',
		'summary',
		'pull_request',
		'unposted',
	] satisfies ThreadPlace[])(
		'a finding with a %s thread is absent from below the floor',
		place => {
			const fixture = input()
			const finding = bug({ placement: 'summary' })
			const text = formatSummaryComment({
				...fixture,
				report: { ...fixture.report, bugs: [finding], rejected: [] },
				plan: {
					threads: [{ finding, kind: 'unverified', place }],
					repeated: [],
					dismissed: [],
					summaryNits: [],
				},
			})
			expect(text).not.toContain('Below the severity floor')
			expect(text).not.toContain('Found again under threads resolved')
		}
	)
	test.each(['repeated', 'dismissed'] as const)(
		'a %s finding is absent from below the floor',
		disposition => {
			const fixture = input()
			const finding = bug({ placement: 'summary' })
			const text = formatSummaryComment({
				...fixture,
				report: { ...fixture.report, bugs: [finding], rejected: [] },
				plan: {
					threads: [],
					repeated: [],
					dismissed: [],
					summaryNits: [],
					[disposition]: [{ finding, kind: 'bug' }],
				},
			})
			expect(text).not.toContain('Below the severity floor')
		}
	)

	test('escapes the rejected validator reason independently of the title and router reason', () => {
		const fixture = input()
		const [rejected] = fixture.report.rejected
		expect(rejected).toBeDefined()
		if (!rejected) return
		const text = formatSummaryComment({
			...fixture,
			report: {
				...fixture.report,
				rejected: [
					{
						...rejected,
						title: 'Safe title',
						reason: `Validator says ${HOSTILE_TEXT}`,
					},
				],
			},
		})
		expect(text).toContain(
			`Safe title: Validator says ${escapeMarkdown(HOSTILE_TEXT)}`
		)
	})

	test('escapes finding details, rejected validator reason, router reason, agent and model names', () => {
		const text = formatSummaryComment(input())
		expect(text).toContain(`router: ${escapeMarkdown(HOSTILE_TEXT)}`)
		expect(text).toContain(`Tokens: ${escapeMarkdown(HOSTILE_TEXT)} 1k`)
		expect(text).toContain(`: ${escapeMarkdown(HOSTILE_TEXT)}`)
		expect(
			text
				.match(/<summary>.*?<\/summary>/gu)
				?.every(
					summary => !summary.includes('octocat') && !summary.includes('<img')
				)
		).toBe(true)
		expect(toTextOutsideCode(text).split('\n').slice(3).join('\n')).not.toMatch(
			/(?<!\\)<img/u
		)
		expect(text).not.toContain('<!-- mng-review:finding')
		expect(parseSummaryMarker(text)).toEqual(SUMMARY_MARKER)
	})
	test('risk signal paths cannot retain bidi controls', () => {
		expect(formatSummaryComment(input())).not.toContain('\u202E')
	})
	test('agent names and router reasons cannot inject table cells', () => {
		const text = formatSummaryComment(input())
		const row =
			text
				.split('\n')
				.find(line => line.startsWith('|') && line.includes('octocat')) ?? ''
		expect(row.match(/(?<!\\)\|/gu)).toHaveLength(4)
	})
	test.each([
		{ place: 'summary', section: 'Not in the diff' },
		{ place: 'pull_request', section: 'About the pull request' },
	] as const)(
		'caps collapsed $place findings at the same limit',
		({ place, section }) => {
			const fixture = input()
			const outside = Array.from({ length: 30 }, (_, index) => ({
				finding: bug({ title: `Finding ${index + 1}` }),
				kind: 'bug' as const,
				place,
			}))
			const text = formatSummaryComment({
				...fixture,
				plan: { ...fixture.plan, threads: outside },
			})
			expect(text).toContain(`${section} (30):`)
			expect(text).toContain('- and 5 more')
			expect(
				text.match(
					new RegExp(
						`<details><summary>${SEVERITY_MARKERS.high} High finding \\d+</summary>`,
						'gu'
					)
				)
			).toHaveLength(25)
			expect(text).toContain('Finding 25')
			expect(text).not.toContain('Finding 26')
		}
	)
	test('hundreds of rejected findings stay bounded and preserve verdict and marker', () => {
		const fixture = input()
		const [rejected] = fixture.report.rejected
		expect(rejected).toBeDefined()
		if (!rejected) return
		const text = formatSummaryComment({
			...fixture,
			report: {
				...fixture.report,
				rejected: Array.from({ length: 400 }, (_, index) => ({
					...rejected,
					title: `Finding ${index} ${HOSTILE_TEXT.repeat(1000)}`,
					reason: HOSTILE_TEXT.repeat(1000),
				})),
			},
			verdict: 'needs fixes',
		})
		expect(text.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS)
		expect(text).toContain('**Verdict: needs fixes**')
		expect(parseSummaryMarker(text)).toEqual(SUMMARY_MARKER)
	})
	test('status text is escaped and carries a summary marker', () => {
		const text = formatStatusComment(HOSTILE_TEXT, SUMMARY_MARKER, LINKS)
		expect(text).toContain(escapeMarkdown(HOSTILE_TEXT))
		expect(text).not.toContain('\u202E')
		expect(parseSummaryMarker(text)).toEqual(SUMMARY_MARKER)
	})
})

describe('toUnfinishedSummary', () => {
	test.each([undefined, false, true])(
		'replaces only the final marker, previously finished=%s',
		finished => {
			const marker = { ...SUMMARY_MARKER, runs: 4, finished }
			const visible = `Verdict: ready\n<!-- ordinary HTML comment -->\n${toMarkerComment('summary', { ...SUMMARY_MARKER, runs: 2 })}\nDetails stay intact.\n\n`
			const body = visible + toMarkerComment('summary', marker)
			const unfinished = toUnfinishedSummary(body, marker)
			expect(unfinished).toBe(
				visible + toMarkerComment('summary', { ...marker, finished: false })
			)
			expect(parseSummaryMarker(unfinished)).toEqual({
				...SUMMARY_MARKER,
				runs: 4,
				finished: false,
			})
			expect(
				toUnfinishedSummary(unfinished, { ...marker, finished: false })
			).toBe(unfinished)
		}
	)

	test('appends a marker to a body without one', () => {
		expect(toUnfinishedSummary('Existing summary', SUMMARY_MARKER)).toBe(
			`Existing summary\n\n${toMarkerComment('summary', { ...SUMMARY_MARKER, finished: false })}`
		)
	})

	test('appends a marker without removing unrelated HTML comments', () => {
		const body =
			'Existing summary\n<!-- ordinary comment -->\nKeep these details.'
		expect(toUnfinishedSummary(body, SUMMARY_MARKER)).toBe(
			`${body}\n\n${toMarkerComment('summary', { ...SUMMARY_MARKER, finished: false })}`
		)
	})

	test('does not invent a last finished head for a summary without one', () => {
		const marker = { v: SUMMARY_MARKER.v, runs: 0 }
		expect(parseSummaryMarker(toUnfinishedSummary('Offline', marker))).toEqual({
			...marker,
			finished: false,
		})
	})
})

describe('summary finding markers', () => {
	test.each(SEVERITIES)(
		'uses the shared %s marker for folded summaries and review lists',
		severity => {
			const finding = bug({ severity })
			const fixture = input()
			const name = `${severity.charAt(0).toUpperCase()}${severity.slice(1)}`
			const text = formatSummaryComment({
				...fixture,
				report: { ...report(), bugs: [finding] },
				plan: {
					threads: [{ finding, kind: 'bug', place: 'summary' }],
					repeated: [],
					dismissed: [],
					summaryNits: [],
				},
			})
			expect(text).toContain(
				`<summary>${SEVERITY_MARKERS[severity]} ${name} finding 1</summary>`
			)
			expect(text).toContain(`${SEVERITY_MARKERS[severity]} **${name}**`)
		}
	)
	test('a nit has no severity marker in its folded heading or list, and summary findings never suggest edits', () => {
		const finding = bug({
			kind: 'nit',
			suggestion: 'Use a unique key.',
			validation: {
				status: 'confirmed',
				severity: 'high',
				reason: 'Confirmed.',
				evidence: [],
				model: 'model',
				edit: {
					commit: LINKS.head,
					line: bug().line,
					original: 'old()',
					replacement: 'new()',
				},
			},
		})
		const text = formatSummaryComment({
			...input(),
			report: { ...report(), bugs: [], nits: [finding] },
			plan: {
				threads: [],
				repeated: [],
				dismissed: [],
				summaryNits: [finding],
			},
		})
		expect(text).toContain('**Nit**')
		expect(text).not.toContain('```suggestion')
		for (const marker of [
			...Object.values(SEVERITY_MARKERS),
			UNVERIFIED_MARKER,
		])
			expect(text).not.toContain(marker)
	})
})

test('summary shows escaped model risk reasons before its final summary marker', () => {
	const body = formatSummaryComment({
		...input(),
		rating: {
			status: 'rated',
			level: 'low',
			reasons: ['<!-- hidden --> **bold**'],
			floors: [],
			reused: false,
		},
	})
	expect(body).toContain('**Risk: low**')
	expect(body).not.toContain('<!-- hidden')
	expect(body).not.toContain('**bold**')
	expect(parseSummaryMarker(body)).toBeDefined()
})
