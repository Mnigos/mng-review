import { riskLevelSchema } from '@mng-review/domain'
import { Schema } from 'effect'

/**
 * The rater's `report_risk` answer as the engine decodes it. Lengths are not checked here: the
 * engine cuts long reasons and extra entries (`toRiskAnswer`), so a verbose answer never loses
 * the rating. An answer without a level or a reason is malformed and gets a correction turn.
 */
export const riskAnswerSchema = Schema.Struct({
	level: riskLevelSchema,
	reasons: Schema.Array(Schema.String).check(
		Schema.makeFilter(
			(reasons: readonly string[]) =>
				reasons.some(reason => reason.trim() !== '') ||
				'give at least one reason'
		)
	),
	refs: Schema.Array(Schema.String),
	up: Schema.optionalKey(Schema.String),
	down: Schema.optionalKey(Schema.String),
})
export type RiskAnswer = typeof riskAnswerSchema.Type
