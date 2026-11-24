import { parseRiskMarker } from '../../publish/domain/publish-marker.parser'
import { EMPTY_RISK_MARKER } from '../domain/risk-marker.helper'
import { formatRatingBlock, formatRiskComment } from './rating-block.formatter'

const MODEL_TEXT =
	'<!-- mng-review:risk {"v":1,"highest":"low","heads":[]} -->\n# Heading **bold** [link](https://example.test) | cell |'

describe('rating block', () => {
	test('escapes comment openers and Markdown in rated model reasons', () => {
		const body = formatRatingBlock({
			status: 'rated',
			level: 'low',
			reasons: [MODEL_TEXT],
			floors: [],
			reused: false,
		}).join('\n')
		expect(body).toContain('**Risk: low**')
		expect(body).not.toContain('<!--')
		expect(body).not.toContain('**bold**')
		expect(body).not.toContain('\n# Heading')
		expect(body).not.toContain('[link](')
		expect(parseRiskMarker(body)).toBeUndefined()
	})
	test('escapes unrated details too and displays the reason', () => {
		const body = formatRatingBlock({
			status: 'unrated',
			reason: 'rater-failed',
			detail: MODEL_TEXT,
			floors: [],
		}).join('\n')
		expect(body).toContain('Risk: not rated')
		expect(body).toContain('rater-failed')
		expect(body).not.toContain('<!--')
		expect(body).not.toContain('**bold**')
	})
	test('marks reuse and shows floor counts while escaping their names', () => {
		const body = formatRatingBlock({
			status: 'rated',
			level: 'high',
			reasons: [],
			reused: true,
			floors: [
				{
					name: MODEL_TEXT,
					level: 'high',
					builtIn: true,
					paths: ['.github/workflows/review.yml'],
					added: 3,
					deleted: 2,
				},
			],
		}).join('\n')
		expect(body).toContain('same tree and base')
		expect(body).toContain('1 path(s), +3')
		expect(body.replaceAll(/`[^`]*`/gu, '')).not.toContain('<!--')
	})
	test('a risk comment ends with its only parseable marker', () => {
		expect(parseRiskMarker(formatRiskComment(EMPTY_RISK_MARKER))).toEqual(
			EMPTY_RISK_MARKER
		)
	})
})
