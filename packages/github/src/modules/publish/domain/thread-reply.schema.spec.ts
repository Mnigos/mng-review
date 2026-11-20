import { Schema } from 'effect'
import {
	ACCEPTED_DECISION,
	decidedReply,
} from '../../../shared/mocks/thread-reply-test.helper'
import {
	decidedThreadReplySchema,
	replyDecisionSchema,
} from './thread-reply.schema'

describe('accepted reply evidence boundary', () => {
	test('replyDecisionSchema rejects accepted with no evidence', () => {
		expect(
			Schema.decodeUnknownExit(replyDecisionSchema)({
				...ACCEPTED_DECISION,
				evidence: [],
			})._tag
		).toBe('Failure')
	})
	test('decidedThreadReplySchema rejects accepted with no evidence', () => {
		expect(
			Schema.decodeUnknownExit(decidedThreadReplySchema)(
				decidedReply({ ...ACCEPTED_DECISION, evidence: [] })
			)._tag
		).toBe('Failure')
	})
	test('accepts a bound decision with one evidence entry', () => {
		expect(
			Schema.decodeUnknownExit(decidedThreadReplySchema)(
				decidedReply(ACCEPTED_DECISION)
			)._tag
		).toBe('Success')
	})
})
