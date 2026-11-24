import { formatSchemaIssue } from '@mng-review/domain'
import { Effect, Schema } from 'effect'
import { riskAnswerSchema } from '../domain/risk-answer.schema'
import { toRiskAnswer } from '../domain/risk-rating.helper'

/**
 * Reads a `report_risk` answer and cuts it to the rating's limits. A malformed answer goes back to
 * the model with the schema's reasons; one that stays malformed leaves the run unrated, never Low.
 */
export function parseRiskAnswer(answer: unknown) {
	return Schema.decodeUnknownEffect(riskAnswerSchema)(answer).pipe(
		Effect.map(toRiskAnswer),
		Effect.mapError(error => ({ message: formatSchemaIssue(error.issue) }))
	)
}
