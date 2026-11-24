import { RATED_LEVELS } from '@mng-review/domain'
import { Schema } from 'effect'
import { Tool } from 'effect/ai'
import {
	MAX_RISK_REASON_CHARS,
	MAX_RISK_REASONS,
} from '../../risk/domain/rater.constants'

/**
 * The finish tool of the rater. Answers are decoded with the rater's answer schema and cut to its
 * limits; the engine, not the model, raises the level for floors and findings.
 */
export const ReportRiskTool = Tool.make('report_risk', {
	description:
		'Rate how much the change needs its owner: low, medium or high, with the reasons that drive it.',
	parameters: Schema.Struct({
		level: Schema.Literals(RATED_LEVELS),
		reasons: Schema.Array(Schema.String).annotate({
			description: `One to ${MAX_RISK_REASONS} plain sentences that drive the level, most important first, each at most ${MAX_RISK_REASON_CHARS} characters.`,
		}),
		refs: Schema.Array(Schema.String).annotate({
			description:
				'`path:start-end` ranges of the diff that drive the level, head line numbers.',
		}),
		up: Schema.String.annotate({
			description:
				'One sentence: what in this change would have made the level higher.',
		}),
		down: Schema.String.annotate({
			description:
				'One sentence: what would have to be absent for the level to be lower.',
		}),
	}),
	success: Schema.String,
})
