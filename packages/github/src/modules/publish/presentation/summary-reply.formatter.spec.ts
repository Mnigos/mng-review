import {
	botThread,
	LINKS,
	SUMMARY_MARKER,
} from '../../../shared/mocks/publish-test.helper'
import { parseSummaryMarker } from '../domain/publish-marker.parser'
import { MAX_SUMMARY_CHARS } from './summary-comment.formatter'
import {
	formatRepliedSummary,
	type RepliedSummaryInput,
} from './summary-reply.formatter'
import { toMarkerComment } from './thread-comment.formatter'

const MARKER = { ...SUMMARY_MARKER, runs: 4, finished: true } as const
const VERDICT =
	'**Verdict: needs fixes** · risk normal (rules) · 1 open bug thread(s) · run 4 of 5'
const DETAILS =
	'\n\n<details><summary>Models</summary>\n\nreviewer: 123 tokens\n\n</details>\n\nFindings and evidence stay here.\n'

/** An existing summary with a distinct verdict, waiting list, model report and marker. */
function summary(waiting = '') {
	return {
		body: `# MNG Review\n\n${VERDICT}${waiting}${DETAILS}\n${toMarkerComment('summary', MARKER)}`,
	}
}

/** A reply-only update that keeps the full review's identity. */
function input(
	overrides: Partial<RepliedSummaryInput> = {}
): RepliedSummaryInput {
	return {
		verdict: 'ready',
		openBugs: 0,
		waiting: [],
		marker: MARKER,
		links: LINKS,
		...overrides,
	}
}

describe('formatRepliedSummary', () => {
	test('replaces the verdict and open count but keeps all other summary text and the run count', () => {
		const current = summary()
		expect(formatRepliedSummary(current, input())).toBe(
			current.body.replace(
				VERDICT,
				'**Verdict: ready** · risk normal (rules) · 0 open bug thread(s) · run 4 of 5'
			)
		)
	})
	test('removes a cleared waiting section and replaces the marker exactly once', () => {
		const waiting =
			'\n\nWaiting for the owner (1):\n\n- `src/old.ts:1` Old question'
		const previous = { ...MARKER, needsOwner: ['old'] }
		const current = {
			body: summary(waiting).body.replace(
				toMarkerComment('summary', MARKER),
				toMarkerComment('summary', previous)
			),
		}
		const text = formatRepliedSummary(current, input())
		expect(text).toBe(
			summary().body.replace(
				VERDICT,
				'**Verdict: ready** · risk normal (rules) · 0 open bug thread(s) · run 4 of 5'
			)
		)
		expect(parseSummaryMarker(text)).toEqual(MARKER)
		expect(text.match(/<!-- mng-review:summary /gu)).toHaveLength(1)
	})
	test('replaces an old waiting list while preserving sections after it', () => {
		const waiting =
			'\n\nWaiting for the owner (2):\n\n- `src/old.ts:1` Old question\n- `src/other.ts:2` Another question'
		const marker = { ...MARKER, needsOwner: ['new'] }
		const text = formatRepliedSummary(
			summary(waiting),
			input({
				verdict: 'needs owner',
				openBugs: 1,
				marker,
				waiting: [botThread({ id: 'new' })],
			})
		)
		expect(text).toContain(
			'**Verdict: needs owner** · risk normal (rules) · 1 open bug thread(s) · run 4 of 5'
		)
		expect(text).toContain('Waiting for the owner (1):')
		expect(text).toContain('Duplicate write loses data')
		expect(text).not.toContain('Old question')
		expect(text).not.toContain('Another question')
		expect(text).toContain(DETAILS)
		expect(parseSummaryMarker(text)).toEqual(marker)
	})
	test('inserts a missing waiting section after the verdict and before the existing details', () => {
		const text = formatRepliedSummary(
			summary(),
			input({
				verdict: 'needs owner',
				openBugs: 1,
				marker: { ...MARKER, needsOwner: ['thread'] },
				waiting: [botThread()],
			})
		)
		expect(text.indexOf('**Verdict: needs owner**')).toBeLessThan(
			text.indexOf('Waiting for the owner (1):')
		)
		expect(text.indexOf('Waiting for the owner (1):')).toBeLessThan(
			text.indexOf('<details>')
		)
		expect(text).toContain(DETAILS)
		expect(text).toContain('run 4 of 5')
	})
	test('keeps only the waiting count when three entries with long paths still exceed the budget', () => {
		const path = `src/${'deep/'.repeat(4000)}file.ts`
		const waiting = ['a', 'b', 'c', 'd'].map(id => botThread({ id, path }))
		const text = formatRepliedSummary(
			summary(),
			input({
				verdict: 'needs owner',
				openBugs: 4,
				marker: { ...MARKER, needsOwner: ['a', 'b', 'c', 'd'] },
				waiting,
			})
		)
		expect(text.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS + 1000)
		expect(text).toContain('Waiting for the owner (4):\n\n- and 4 more')
		expect(text).not.toContain('file.ts')
		expect(text).toContain(DETAILS)
	})
	test('without a summary it does not invent a full review', () => {
		const marker = { ...SUMMARY_MARKER, runs: 0 }
		const text = formatRepliedSummary(undefined, input({ marker }))
		expect(text).toContain(
			'Replies in the threads were answered; no review has been summarized on this pull request yet.'
		)
		expect(text).not.toContain('**Verdict: ready**')
		expect(parseSummaryMarker(text)).toEqual(marker)
	})
})
