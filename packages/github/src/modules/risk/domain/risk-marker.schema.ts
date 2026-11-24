import {
	commitShaSchema,
	riskDescriptionSchema,
	riskLevelSchema,
	statusLevelSchema,
} from '@mng-review/domain'
import { Schema } from 'effect'
import { MARKER_VERSION } from '../../publish/domain/publish.constants'
import { MAX_RATED_HEADS } from './risk.constants'

/**
 * A head the app rated: its tree, the merge base and the rules digest it was rated on, and the
 * level it got.
 */
export const ratedHeadSchema = Schema.Struct({
	head: commitShaSchema,
	tree: commitShaSchema,
	base: commitShaSchema,
	rules: riskDescriptionSchema.fields.rules,
	level: riskLevelSchema,
})
export type RatedHead = typeof ratedHeadSchema.Type

/**
 * The hidden marker of the app's risk comment: the highest level ever published for the pull
 * request and the last `MAX_RATED_HEADS` rated heads. It only ever adds heads and raises.
 */
export const riskMarkerSchema = Schema.Struct({
	v: Schema.Literal(MARKER_VERSION),
	highest: statusLevelSchema,
	heads: Schema.Array(ratedHeadSchema).check(
		Schema.isMaxLength(MAX_RATED_HEADS)
	),
})
export type RiskMarker = typeof riskMarkerSchema.Type
