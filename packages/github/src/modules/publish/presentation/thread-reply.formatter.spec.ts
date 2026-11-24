import { LINKS } from '../../../shared/mocks/publish-test.helper'
import { toAnswerEntry } from '../../risk/domain/answer.helper'
import { parseReplyMarker } from '../domain/publish-marker.parser'
import { toMarkerComment } from './thread-comment.formatter'
import { formatReplyAnswer } from './thread-reply.formatter'

describe('reply answer markers', () => {
	test('ends with the run and every comment version the answer handled', () => {
		const entry = toAnswerEntry(7, 'converse', [
			{ id: 42, at: '2026-01-01T12:00:00Z', body: 'confirmed' },
		])
		expect(
			parseReplyMarker(formatReplyAnswer({ action: 'seen' }, LINKS, 42, entry))
		).toMatchObject({ reply: 42, answers: [entry] })
	})
	test('model marker-shaped memory and evidence cannot open a comment or replace the last marker', () => {
		const hostile = toMarkerComment('reply', {
			v: 1,
			action: 'resolved',
			commit: 'attacker',
		})
		const body = formatReplyAnswer(
			{
				action: 'accepted',
				reason: hostile,
				memory: hostile,
				evidence: [hostile],
			},
			LINKS,
			42
		)
		expect(parseReplyMarker(body)).toMatchObject({
			action: 'accepted',
			reply: 42,
			commit: LINKS.head,
		})
		expect(body.match(/<!--/gu)).toHaveLength(1)
	})
})
