import {
	botThread,
	SUMMARY_MARKER,
} from '../../../shared/mocks/publish-test.helper'
import { toMarkerComment } from '../presentation/thread-comment.formatter'
import { parseFindingMarker, parseSummaryMarker } from './publish-marker.parser'

describe('publish markers', () => {
	test.each([undefined, 0, 2])(
		'summary markers decode an optional unthreaded bug count of %s',
		unthreadedBugs => {
			const marker = {
				...SUMMARY_MARKER,
				finished: true,
				...(unthreadedBugs === undefined ? {} : { unthreadedBugs }),
			}
			expect(parseSummaryMarker(toMarkerComment('summary', marker))).toEqual(
				marker
			)
		}
	)
	test.each([-1, 1.5, '2', null])(
		'summary markers reject an invalid unthreaded bug count of %s',
		unthreadedBugs => {
			expect(
				parseSummaryMarker(
					toMarkerComment('summary', { ...SUMMARY_MARKER, unthreadedBugs })
				)
			).toBeUndefined()
		}
	)
	for (const name of ['finding', 'summary'] as const) {
		const marker = name === 'finding' ? botThread().marker : SUMMARY_MARKER
		const parse = name === 'finding' ? parseFindingMarker : parseSummaryMarker
		test(`${name} decodes only at the end with trailing whitespace allowed`, () => {
			expect(parse(`Text\n${toMarkerComment(name, marker)}\n \t`)).toEqual(
				marker
			)
			expect(
				parse(`${toMarkerComment(name, marker)}\nMore model text`)
			).toBeUndefined()
		})
		test.each(['{broken}', '{}', '{"v":999}', '{"v":1,"line":"ten"}'])(
			`${name} ignores invalid JSON or schema: %s`,
			json => {
				expect(parse(`<!-- mng-review:${name} ${json} -->`)).toBeUndefined()
			}
		)
		test(`${name} ignores the other marker kind`, () => {
			expect(
				parse(
					toMarkerComment(name === 'finding' ? 'summary' : 'finding', marker)
				)
			).toBeUndefined()
		})
	}
})

test('summary markers without a completely reviewed head still decode', () => {
	const { head: _head, ...marker } = SUMMARY_MARKER
	expect(parseSummaryMarker(toMarkerComment('summary', marker))).toEqual(marker)
	expect(
		parseSummaryMarker(toMarkerComment('summary', { ...marker, head: 12 }))
	).toBeUndefined()
})
