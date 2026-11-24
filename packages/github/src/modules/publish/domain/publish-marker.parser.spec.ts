import { toAnswerDigest } from '@mng-review/domain'
import {
	botThread,
	SUMMARY_MARKER,
} from '../../../shared/mocks/publish-test.helper'
import { toMarkerComment } from '../presentation/thread-comment.formatter'
import {
	hasRiskMarker,
	parseAnswerMarker,
	parseFindingMarker,
	parseReplyMarker,
	parseRiskMarker,
	parseSummaryMarker,
} from './publish-marker.parser'

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

describe('answer markers', () => {
	const entry = {
		run: 7,
		kind: 'deny',
		ids: [
			{ id: 42, at: '2026-01-01T12:00:00Z', digest: toAnswerDigest('command') },
		],
	} as const
	test('decodes the new answer marker and answer entries in a reply and summary', () => {
		expect(
			parseAnswerMarker(toMarkerComment('answer', { v: 1, answers: [entry] }))
				?.answers
		).toEqual([entry])
		expect(
			parseReplyMarker(
				toMarkerComment('reply', {
					v: 1,
					action: 'seen',
					commit: 'head',
					answers: [entry],
				})
			)?.answers
		).toEqual([entry])
		expect(
			parseSummaryMarker(
				toMarkerComment('summary', { v: 1, runs: 1, answers: [entry] })
			)?.answers
		).toEqual([entry])
	})
	for (const separator of ['\n', ' '])
		test(`only the last marker counts with separator ${JSON.stringify(separator)}`, () => {
			const first = toMarkerComment('answer', { v: 1, answers: [entry] })
			const last = toMarkerComment('summary', { v: 1, runs: 2 })
			expect(parseAnswerMarker(`${first}${separator}${last}`)).toBeUndefined()
			expect(parseSummaryMarker(`${first}${separator}${last}`)).toEqual({
				v: 1,
				runs: 2,
			})
		})
	test('an invalid answer entry is rejected at the model-output boundary', () => {
		expect(
			parseAnswerMarker(
				toMarkerComment('answer', {
					v: 1,
					answers: [{ ...entry, ids: [{ ...entry.ids[0], digest: 'bad' }] }],
				})
			)
		).toBeUndefined()
	})
})

describe('risk marker boundary', () => {
	const marker = {
		v: 1,
		highest: 'high',
		heads: [
			{
				head: 'a'.repeat(40),
				tree: 'b'.repeat(40),
				base: 'c'.repeat(40),
				rules: 'd'.repeat(12),
				level: 'high',
			},
		],
	} as const
	test('decodes a valid risk marker only when it is the final marker', () => {
		const body = toMarkerComment('risk', marker)
		expect(parseRiskMarker(`${body}\n \t`)).toEqual(marker)
		expect(hasRiskMarker(body)).toBeTruthy()
		expect(parseRiskMarker(`${body}\nMore model text`)).toBeUndefined()
		expect(hasRiskMarker(`${body}\nMore model text`)).toBe(false)
		expect(
			parseRiskMarker(`${body}\n${toMarkerComment('summary', SUMMARY_MARKER)}`)
		).toBeUndefined()
	})
	test.each([
		'{broken}',
		'{}',
		'{"v":2,"highest":"high","heads":[]}',
		'{"v":1,"highest":"unknown","heads":[]}',
	])('recognizes but does not trust invalid risk marker data %s', json => {
		const body = `<!-- mng-review:risk ${json} -->`
		expect(hasRiskMarker(body)).toBeTruthy()
		expect(parseRiskMarker(body)).toBeUndefined()
	})
	test('summary risk is optional and restricted to rated levels', () => {
		for (const risk of ['low', 'medium', 'high'])
			expect(
				parseSummaryMarker(
					toMarkerComment('summary', { ...SUMMARY_MARKER, risk })
				)?.risk
			).toBe(risk)
		expect(
			parseSummaryMarker(toMarkerComment('summary', SUMMARY_MARKER))?.risk
		).toBeUndefined()
		expect(
			parseSummaryMarker(
				toMarkerComment('summary', { ...SUMMARY_MARKER, risk: 'none' })
			)
		).toBeUndefined()
	})
})
