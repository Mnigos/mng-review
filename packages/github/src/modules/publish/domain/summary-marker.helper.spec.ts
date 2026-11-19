import { SUMMARY_MARKER } from '../../../shared/mocks/publish-test.helper'
import { MARKER_VERSION } from './publish.constants'
import { toNextSummaryMarker } from './summary-marker.helper'

describe('toNextSummaryMarker', () => {
	test('a finished run replaces the reviewed head and unthreaded bug count', () => {
		expect(
			toNextSummaryMarker(
				{ ...SUMMARY_MARKER, runs: 4, finished: false, unthreadedBugs: 3 },
				{ head: 'next', finished: true, unthreadedBugs: 2 }
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
					{ head: 'next', finished: false, unthreadedBugs }
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
					{ head: 'clean', finished: true, unthreadedBugs: 0 }
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
				unthreadedBugs: 2,
			})
		).toEqual({
			...SUMMARY_MARKER,
			runs: SUMMARY_MARKER.runs + 1,
			finished: false,
		})
	})
})
