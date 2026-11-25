import {
	LINKS,
	report,
	SUMMARY_MARKER,
} from '../../../shared/mocks/publish-test.helper'
import { parseSummaryMarker } from '../domain/publish-marker.parser'
import type { SummaryComment } from '../domain/publish.types'
import {
	formatSummaryComment,
	type SummaryInput,
} from './summary-comment.formatter'
import {
	toOfflineSummary,
	toReservedStatus,
	toReservedSummary,
} from './summary-status.formatter'
import { toMarkerComment } from './thread-comment.formatter'

const MARKER = {
	...SUMMARY_MARKER,
	runs: 4,
	manualRuns: 2,
	finished: true,
	unthreadedBugs: 3,
	needsOwner: ['waiting'],
	reviewedAt: '2026-11-20T10:00:00.000Z',
} as const
const PRIOR = {
	id: 101,
	nodeId: 'review-node',
	mine: true,
	marker: MARKER,
	body: `**Verdict: needs fixes**\nEvidence stays.\n\n${toMarkerComment('summary', MARKER)}`,
} as const satisfies SummaryComment

describe('summary review bodies', () => {
	test('offline preserves visible text and all marker fields except finished', () => {
		const offline = toOfflineSummary(PRIOR, 'offline', LINKS)
		expect(offline.body.split('<!--')[0]).toBe(PRIOR.body.split('<!--')[0])
		expect(offline.marker).toEqual({ ...MARKER, finished: false })
		expect(parseSummaryMarker(offline.body)).toEqual(offline.marker)
	})
	test('a reservation increments only manualRuns and retains the prior visible body', () => {
		const reserved = toReservedSummary(PRIOR)
		expect(reserved.body.split('<!--')[0]).toBe(PRIOR.body.split('<!--')[0])
		expect(reserved.marker).toEqual({ ...MARKER, manualRuns: 3 })
		expect(parseSummaryMarker(reserved.body)).toEqual(reserved.marker)
	})
	for (const prior of [undefined, MARKER])
		test(`a new reservation status with prior=${prior !== undefined} has no heading and carries the marker`, () => {
			const reserved = toReservedStatus(prior, 'review-bot', LINKS)
			expect(reserved.body.startsWith('A command to `@review-bot`')).toBe(true)
			expect(reserved.body).not.toMatch(/^#/mu)
			expect(reserved.marker).toEqual(
				prior
					? { ...MARKER, manualRuns: 3 }
					: { v: SUMMARY_MARKER.v, runs: 0, finished: false, manualRuns: 1 }
			)
			expect(parseSummaryMarker(reserved.body)).toEqual(reserved.marker)
		})
	test('a new offline status starts with its status and has no reviewed head or heading', () => {
		const offline = toOfflineSummary(undefined, 'offline', LINKS)
		expect(offline.body.startsWith('offline\n')).toBe(true)
		expect(offline.body).not.toMatch(/^#/mu)
		expect(parseSummaryMarker(offline.body)).toEqual({
			v: SUMMARY_MARKER.v,
			runs: 0,
			finished: false,
		})
	})
	test('a reviewed body starts with the verdict and places agents and tokens after findings and run notes', () => {
		const reviewed = report()
		const input = {
			report: {
				...reviewed,
				incomplete: { reason: 'Budget spent', unfinished: ['reviewer'] },
			},
			plan: { threads: [], repeated: [], dismissed: [], summaryNits: [] },
			verdict: 'needs fixes',
			openBugs: 1,
			marker: MARKER,
			maxRuns: 6,
			links: LINKS,
			resolved: [],
			tokens: {},
		} satisfies SummaryInput
		const body = formatSummaryComment(input)
		expect(body.startsWith('**Verdict: needs fixes**')).toBe(true)
		expect(body).not.toContain('## MNG Review')
		const details = body.indexOf(
			'<details><summary>Agents and tokens</summary>'
		)
		expect(details).toBeGreaterThan(body.indexOf('Budget spent'))
		expect(body.slice(details)).toContain('Tokens')
		expect(body.slice(details)).toContain('</details>')
		expect(parseSummaryMarker(body)).toEqual(MARKER)
	})
})
