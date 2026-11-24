import { SUMMARY_MARKER } from '../../../shared/mocks/publish-test.helper'
import type { SummaryMarker } from './publish-marker.schema'
import { MARKER_VERSION } from './publish.constants'
import {
	getCarriedBugs,
	type MarkerUpdate,
	toNextSummaryMarker,
	toRepliedMarker,
} from './summary-marker.helper'

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
							{ head: 'head', partial, finished: true, unthreadedBugs: 0 }
						)
					).toBe(partial && head === 'head' ? (unthreadedBugs ?? 0) : 0)
				})
	test('no previous marker carries no bugs', () => {
		expect(
			getCarriedBugs(undefined, {
				head: 'head',
				partial: true,
				finished: true,
				unthreadedBugs: 0,
			})
		).toBe(0)
	})
})

describe('summary marker accumulation on the reviewed head', () => {
	for (const partial of [false, true])
		for (const previousFinished of [false, true])
			for (const previousBugs of [undefined, 2])
				for (const sameHead of [false, true])
					for (const ownBugs of [0, 1])
						test(`partial=${partial}, previous finished=${previousFinished}, prior bugs=${previousBugs}, same head=${sameHead}, own bugs=${ownBugs}`, () => {
							const previous = {
								...PREVIOUS,
								finished: previousFinished,
								...(previousBugs === undefined
									? {}
									: { unthreadedBugs: previousBugs }),
							}
							const snapshot = structuredClone(previous)
							const update = {
								head: sameHead ? previous.head : 'other-head',
								partial,
								finished: partial,
								unthreadedBugs: ownBugs,
							} as const satisfies MarkerUpdate
							const total = (previousBugs ?? 0) + (sameHead ? ownBugs : 0)
							const marker = toNextSummaryMarker(previous, update)
							expect(marker).toEqual({
								...PREVIOUS,
								runs: PREVIOUS.runs + 1,
								finished: partial ? previousFinished : false,
								...(total > 0 ? { unthreadedBugs: total } : {}),
							})
							expect(getCarriedBugs(marker, update)).toBe(
								sameHead ? (previousBugs ?? 0) : 0
							)
							expect(previous).toEqual(snapshot)
						})
	test('an unfinished agent-only run adds its bug and preserves the finished full review', () => {
		const update = {
			head: PREVIOUS.head,
			partial: true,
			finished: false,
			unthreadedBugs: 1,
		} as const satisfies MarkerUpdate
		const marker = toNextSummaryMarker(
			{ ...PREVIOUS, unthreadedBugs: 2 },
			update
		)
		expect(marker).toEqual({ ...PREVIOUS, runs: 9, unthreadedBugs: 3 })
		expect(getCarriedBugs(marker, update)).toBe(2)
	})
	test('a finished full review on the same head replaces the count with only its own bugs', () => {
		const update = {
			head: PREVIOUS.head,
			partial: false,
			finished: true,
			unthreadedBugs: 1,
		} as const satisfies MarkerUpdate
		const marker = toNextSummaryMarker(
			{ ...PREVIOUS, unthreadedBugs: 2 },
			update
		)
		expect(marker).toEqual({ ...PREVIOUS, runs: 9, unthreadedBugs: 1 })
		expect(getCarriedBugs(marker, update)).toBe(0)
	})
	test('carried bugs never become negative when the recorded count is smaller than this run', () => {
		expect(
			getCarriedBugs(
				{ head: PREVIOUS.head, unthreadedBugs: 1 },
				{
					head: PREVIOUS.head,
					partial: false,
					finished: false,
					unthreadedBugs: 2,
				}
			)
		).toBe(0)
	})
})

describe('toNextSummaryMarker waiting threads', () => {
	test('adds new ids once, removes cleared ids and keeps the rest across heads', () => {
		expect(
			toNextSummaryMarker(
				{ ...SUMMARY_MARKER, needsOwner: ['cleared', 'kept'] },
				{
					head: 'new-head',
					finished: true,
					partial: false,
					unthreadedBugs: 0,
					waiting: { added: ['added', 'added'], cleared: new Set(['cleared']) },
				}
			).needsOwner
		).toEqual(['kept', 'added'])
	})
	test('omits the list when the last id is cleared', () => {
		expect(
			toNextSummaryMarker(
				{ ...SUMMARY_MARKER, needsOwner: ['cleared'] },
				{
					head: 'new-head',
					finished: true,
					partial: false,
					unthreadedBugs: 0,
					waiting: { added: [], cleared: new Set(['cleared']) },
				}
			)
		).not.toHaveProperty('needsOwner')
	})
	test('keeps the waiting list when no update was supplied', () => {
		expect(
			toNextSummaryMarker(
				{ ...SUMMARY_MARKER, needsOwner: ['kept'] },
				{ head: 'new-head', finished: false, partial: true, unthreadedBugs: 0 }
			).needsOwner
		).toEqual(['kept'])
	})
})

describe('toNextSummaryMarker failed runs', () => {
	const update = {
		head: 'head',
		finished: true,
		partial: false,
		unthreadedBugs: 0,
	} as const
	test('a finished full run with a failed run records it', () => {
		expect(
			toNextSummaryMarker(SUMMARY_MARKER, { ...update, failed: true })
		).toMatchObject({ head: 'head', finished: true, failed: true })
	})
	test('a finished full run with none failed clears an earlier failed flag', () => {
		expect(
			toNextSummaryMarker(
				{ ...SUMMARY_MARKER, failed: true },
				{ ...update, failed: false }
			)
		).not.toHaveProperty('failed')
	})
	test('an unfinished full run records no failed flag', () => {
		expect(
			toNextSummaryMarker(SUMMARY_MARKER, {
				...update,
				finished: false,
				failed: true,
			})
		).not.toHaveProperty('failed')
	})
	test('a partial run keeps the last full run failed flag', () => {
		expect(
			toNextSummaryMarker(
				{ ...SUMMARY_MARKER, head: 'head', finished: true, failed: true },
				{ ...update, partial: true, failed: false }
			)
		).toMatchObject({ finished: true, failed: true })
	})
})

describe('toRepliedMarker', () => {
	test.each([false, true])(
		'changes only the waiting list with finished=%s',
		finished => {
			const previous = {
				...PREVIOUS,
				finished,
				unthreadedBugs: 2,
				needsOwner: ['cleared', 'kept'],
			}
			const snapshot = structuredClone(previous)
			expect(
				toRepliedMarker(previous, {
					added: ['new', 'new', 'kept'],
					cleared: new Set(['cleared']),
				})
			).toEqual({ ...previous, needsOwner: ['kept', 'new'] })
			expect(previous).toEqual(snapshot)
		}
	)
	test('omits a fully cleared waiting list and keeps every review field', () => {
		expect(
			toRepliedMarker(
				{ ...PREVIOUS, unthreadedBugs: 3, needsOwner: ['cleared'] },
				{ added: [], cleared: new Set(['cleared']) }
			)
		).toEqual({ ...PREVIOUS, unthreadedBugs: 3 })
	})
	test('a legacy marker gains no full review fields', () => {
		expect(
			toRepliedMarker(SUMMARY_MARKER, { added: [], cleared: new Set() })
		).toEqual(SUMMARY_MARKER)
	})
	test('no earlier summary starts at zero runs without claiming a reviewed head', () => {
		expect(
			toRepliedMarker(undefined, { added: ['new'], cleared: new Set() })
		).toEqual({ v: MARKER_VERSION, runs: 0, needsOwner: ['new'] })
	})
})
