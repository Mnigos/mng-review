import { REPLY_CLAIMS } from '@mng-review/domain'
import { Schema } from 'effect'
import { Tool } from 'effect/ai'

/**
 * The finish tool of a reply classifier. Answers are decoded with the domain's reply answer
 * schema; the engine, not the model, decides what the bot does with the reply.
 */
export const ReportReplyTool = Tool.make('report_reply', {
	description:
		'Say what the author claims in the reply, whether an intentional reason holds against the code, and the evidence.',
	parameters: Schema.Struct({
		claim: Schema.Literals(REPLY_CLAIMS),
		holds: Schema.optionalKey(
			Schema.Boolean.annotate({
				description:
					'For intentional only: true when the code bears the reason out.',
			})
		),
		reason: Schema.optionalKey(
			Schema.String.annotate({
				description:
					"The author's reason restated in one sentence, at most 300 characters.",
			})
		),
		failed_premise: Schema.optionalKey(
			Schema.String.annotate({
				description:
					'For intentional that does not hold: the part of the reason the code contradicts, one sentence.',
			})
		),
		evidence: Schema.Array(Schema.String).annotate({
			description: '`path:line` entries, each with a few words.',
		}),
	}),
	success: Schema.String,
})
