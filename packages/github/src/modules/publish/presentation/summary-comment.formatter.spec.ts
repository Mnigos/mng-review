import { agent, config } from '../../../shared/mocks/domain-test.helper'
import { HOSTILE_TEXT } from '../../../shared/mocks/hostile-text.helper'
import {
	bug,
	LINKS,
	report,
	SUMMARY_MARKER,
} from '../../../shared/mocks/publish-test.helper'
import { escapeMarkdown } from '../../../utils/markdown.util'
import { parseSummaryMarker } from '../domain/publish-marker.parser'
import { planPublish } from '../domain/publish-plan.helper'
import type { ThreadPlace } from '../domain/publish.types'
import {
	formatSummaryComment,
	formatStatusComment,
	MAX_SUMMARY_CHARS,
	type SummaryInput,
} from './summary-comment.formatter'

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
	}
}

describe('formatSummaryComment', () => {
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
			`Found again under threads resolved without a code change, not blocking (1):\n\n- **High** \`src/store.ts:10\` ${escapeMarkdown(HOSTILE_TEXT)}`
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
				`Below the severity floor (1):\n\n- **${unverified ? 'Unverified, medium' : 'Medium'}** \`src/store.ts:10\` ${finding.title}`
			)
			expect(text).not.toContain('New threads')
		}
	)
	test.each(['line', 'file', 'summary', 'unposted'] satisfies ThreadPlace[])(
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
		expect(text.split('\n').slice(3).join('\n')).not.toMatch(/(?<!\\)<img/u)
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
