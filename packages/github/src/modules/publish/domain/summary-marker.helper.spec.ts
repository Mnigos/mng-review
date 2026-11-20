import { SUMMARY_MARKER } from '../../../shared/mocks/publish-test.helper'
import type { SummaryMarker } from './publish-marker.schema'
import { MARKER_VERSION } from './publish.constants'
import { getCarriedBugs, toNextSummaryMarker } from './summary-marker.helper'

describe('toNextSummaryMarker', () => {
	test('a finished run replaces the reviewed head and unthreaded bug count', () => {
		expect(
			toNextSummaryMarker(
				{ ...SUMMARY_MARKER, runs: 4, finished: false, unthreadedBugs: 3 },
				{ head: 'next', finished: true, partial: false, unthreadedBugs: 2 }
			)
		).toEqual({
			v: MARKER_VERSION,
			runs: 5,
			head: 'next',
			finished: true,
			unthreadedBugs: 2,
		})
	})

	test.each([0, 7])(
		'an unfinished run keeps the last finished head and count despite %s new bugs',
		unthreadedBugs => {
			expect(
				toNextSummaryMarker(
					{ ...SUMMARY_MARKER, runs: 4, finished: true, unthreadedBugs: 3 },
					{ head: 'next', finished: false, partial: false, unthreadedBugs }
				)
			).toEqual({
				...SUMMARY_MARKER,
				runs: 5,
				finished: false,
				unthreadedBugs: 3,
			})
		}
	)

	test('the first finished run records its head and count', () => {
		expect(
			toNextSummaryMarker(undefined, {
				head: 'first',
				finished: true,
				partial: false,
				unthreadedBugs: 2,
			})
		).toEqual({
			v: MARKER_VERSION,
			runs: 1,
			head: 'first',
			finished: true,
			unthreadedBugs: 2,
		})
	})

	test('the first unfinished run records neither a head nor its partial bug count', () => {
		expect(
			toNextSummaryMarker(undefined, {
				head: 'partial',
				finished: false,
				partial: false,
				unthreadedBugs: 2,
			})
		).toEqual({ v: MARKER_VERSION, runs: 1, finished: false })
	})

	test.each([undefined, 3])(
		'a finished clean run omits zero and clears a previous count of %s',
		unthreadedBugs => {
			expect(
				toNextSummaryMarker(
					{ ...SUMMARY_MARKER, unthreadedBugs },
					{ head: 'clean', finished: true, partial: false, unthreadedBugs: 0 }
				)
			).toEqual({
				v: MARKER_VERSION,
				runs: SUMMARY_MARKER.runs + 1,
				head: 'clean',
				finished: true,
			})
		}
	)

	test('an unfinished run preserves a legacy marker without adding a count', () => {
		expect(
			toNextSummaryMarker(SUMMARY_MARKER, {
				head: 'partial',
				finished: false,
				partial: false,
				unthreadedBugs: 2,
			})
		).toEqual({
			...SUMMARY_MARKER,
			runs: SUMMARY_MARKER.runs + 1,
			finished: false,
		})
	})
})

const PREVIOUS = {
	v: MARKER_VERSION,
	runs: 8,
	manualRuns: 2,
	head: 'last-full-head',
	finished: true,
} as const satisfies SummaryMarker

describe('toNextSummaryMarker partial review rules', () => {
	test('a full finished run advances the head and keeps the reserved manual runs', () => {
		expect(
			toNextSummaryMarker(PREVIOUS, {
				head: 'new-head',
				finished: true,
				partial: false,
				unthreadedBugs: 0,
			})
		).toEqual({
			...PREVIOUS,
			runs: 9,
			head: 'new-head',
			finished: true,
		})
	})
	test('an unfinished full run retains the prior head and resets finished', () => {
		expect(
			toNextSummaryMarker(PREVIOUS, {
				head: 'partial-head',
				finished: false,
				partial: false,
				unthreadedBugs: 0,
			})
		).toEqual({
			...PREVIOUS,
			runs: 9,
			finished: false,
		})
	})
	test.each([false, true])(
		'an agent-only run retains finished=%s and the prior full head',
		finished => {
			expect(
				toNextSummaryMarker(
					{ ...PREVIOUS, finished },
					{
						head: 'agent-head',
						finished: !finished,
						partial: true,
						unthreadedBugs: 0,
					}
				)
			).toEqual({
				...PREVIOUS,
				finished,
				runs: 9,
			})
		}
	)
	test.each([false, true])(
		'an agent-only first run never claims a full head, answered=%s',
		finished => {
			expect(
				toNextSummaryMarker(undefined, {
					head: 'agent-head',
					finished,
					partial: true,
					unthreadedBugs: 0,
				})
			).toEqual({
				v: MARKER_VERSION,
				runs: 1,
				finished: false,
			})
		}
	)
	test.each([undefined, 0])(
		'preserves the manual count from legacy or zero marker %s',
		manualRuns => {
			const previous = {
				v: MARKER_VERSION,
				runs: 1,
				...(manualRuns === undefined ? {} : { manualRuns }),
			} as const
			expect(
				toNextSummaryMarker(previous, {
					head: 'new-head',
					finished: true,
					partial: false,
					unthreadedBugs: 0,
				})
			).toEqual({
				v: MARKER_VERSION,
				runs: 2,
				...(manualRuns === undefined ? {} : { manualRuns }),
				head: 'new-head',
				finished: true,
			})
		}
	)
	test.each([false, true])(
		'first full run finished=%s only records a head if finished',
		finished => {
			expect(
				toNextSummaryMarker(undefined, {
					head: 'first-head',
					finished,
					partial: false,
					unthreadedBugs: 0,
				})
			).toEqual({
				v: MARKER_VERSION,
				runs: 1,
				finished,
				...(finished ? { head: 'first-head' } : {}),
			})
		}
	)
	test('does not mutate the previous marker', () => {
		const previous = structuredClone(PREVIOUS)
		toNextSummaryMarker(previous, {
			head: 'new-head',
			finished: true,
			partial: false,
			unthreadedBugs: 0,
		})
		expect(previous).toEqual(PREVIOUS)
	})
})

describe('toNextSummaryMarker unthreaded bugs', () => {
	test('a full finished review replaces the previous count', () => {
		expect(
			toNextSummaryMarker(
				{ ...PREVIOUS, unthreadedBugs: 3 },
				{
					head: 'new-head',
					finished: true,
					partial: false,
					unthreadedBugs: 2,
				}
			)
		).toEqual({ ...PREVIOUS, runs: 9, head: 'new-head', unthreadedBugs: 2 })
	})
	test('a clean full finished review omits the cleared count', () => {
		expect(
			toNextSummaryMarker(
				{ ...PREVIOUS, unthreadedBugs: 3 },
				{
					head: PREVIOUS.head,
					finished: true,
					partial: false,
					unthreadedBugs: 0,
				}
			)
		).toEqual({ ...PREVIOUS, runs: 9 })
	})
	for (const unthreadedBugs of [0, 5])
		for (const partial of [false, true])
			test(`an unfinished run keeps prior bugs, partial=${partial}, new count=${unthreadedBugs}`, () => {
				expect(
					toNextSummaryMarker(
						{ ...PREVIOUS, unthreadedBugs: 3 },
						{
							head: 'new-head',
							finished: false,
							partial,
							unthreadedBugs,
						}
					)
				).toEqual({
					...PREVIOUS,
					runs: 9,
					finished: partial,
					unthreadedBugs: 3,
				})
			})
	test('a finished agent-only run keeps prior bugs instead of its own count', () => {
		expect(
			toNextSummaryMarker(
				{ ...PREVIOUS, unthreadedBugs: 3 },
				{
					head: 'new-head',
					finished: true,
					partial: true,
					unthreadedBugs: 5,
				}
			)
		).toEqual({ ...PREVIOUS, runs: 9, unthreadedBugs: 3 })
	})
	test('a first unfinished full review never records its unthreaded bugs', () => {
		expect(
			toNextSummaryMarker(undefined, {
				head: 'new-head',
				finished: false,
				partial: false,
				unthreadedBugs: 2,
			})
		).toEqual({ v: MARKER_VERSION, runs: 1, finished: false })
	})
})

describe('getCarriedBugs', () => {
	for (const partial of [false, true])
		for (const head of ['head', 'other-head', undefined])
			for (const unthreadedBugs of [undefined, 0, 3])
				test(`partial=${partial}, marker head=${head}, bugs=${unthreadedBugs}`, () => {
					expect(
						getCarriedBugs(
							{ ...SUMMARY_MARKER, head, unthreadedBugs },
							{ head: 'head', partial }
						)
					).toBe(partial && head === 'head' ? (unthreadedBugs ?? 0) : 0)
				})
	test('no previous marker carries no bugs', () => {
		expect(getCarriedBugs(undefined, { head: 'head', partial: true })).toBe(0)
	})
})
