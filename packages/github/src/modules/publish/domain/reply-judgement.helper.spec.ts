import { SUMMARY_MARKER } from '../../../shared/mocks/publish-test.helper'
import { toReplyJudgement } from './reply-judgement.helper'

/** A wait the owner cleared, one still waiting and one the run holds for itself only. */
const INPUT = {
	waits: {
		all: ['cleared', 'waiting'],
		held: ['held'],
		cleared: new Set(['cleared']),
	},
	head: 'head',
	threadBugs: 0,
} as const

describe('toReplyJudgement', () => {
	test('a complete run stores the waits an owner did not clear and judges the held one too', () => {
		const judgement = toReplyJudgement(
			{ ...SUMMARY_MARKER, head: 'head', finished: true },
			false,
			INPUT
		)
		expect(judgement.marker.needsOwner).toEqual(['waiting'])
		expect(judgement.judging.needsOwner).toEqual(['waiting', 'held'])
		expect(judgement.standing).toEqual({
			openBugs: 0,
			finished: true,
			verdict: 'needs owner',
		})
	})
	test('an incomplete run clears no wait', () => {
		expect(
			toReplyJudgement(
				{ ...SUMMARY_MARKER, head: 'head', finished: true },
				true,
				INPUT
			).marker.needsOwner
		).toEqual(['cleared', 'waiting'])
	})
	test('the marker keeps the run count and the unthreaded bugs of the head', () => {
		const judgement = toReplyJudgement(
			{ ...SUMMARY_MARKER, runs: 3, head: 'head', unthreadedBugs: 2 },
			false,
			{ ...INPUT, waits: { all: [], held: [], cleared: new Set() } }
		)
		expect(judgement.marker).toMatchObject({ runs: 3, unthreadedBugs: 2 })
		expect(judgement.standing).toMatchObject({
			openBugs: 2,
			verdict: 'needs fixes',
		})
	})
})
