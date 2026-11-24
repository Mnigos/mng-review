import { Schema } from 'effect'
import {
	BASE_SHA_PATTERN,
	FLOOR_LEVELS,
	NONCE_PATTERN,
	RATED_LEVELS,
	RISK_STATUS_STATES,
	RULES_DIGEST_PATTERN,
	STATUS_LEVELS,
} from './risk.constants'

export const riskLevelSchema = Schema.Literals(RATED_LEVELS)
export type RiskLevel = typeof riskLevelSchema.Type
export const statusLevelSchema = Schema.Literals(STATUS_LEVELS)
export type StatusLevel = typeof statusLevelSchema.Type
export const floorLevelSchema = Schema.Literals(FLOOR_LEVELS)
export type FloorLevel = typeof floorLevelSchema.Type
export const riskStatusStateSchema = Schema.Literals(RISK_STATUS_STATES)
export type RiskStatusState = typeof riskStatusStateSchema.Type

/** What one `MNG Review risk` status says: whose rating it is, the level and what it was rated on. */
export const riskDescriptionSchema = Schema.Struct({
	/** The pull request the rating belongs to; readers take only statuses for their own number. */
	pr: Schema.Int.check(Schema.isGreaterThan(0)),
	level: statusLevelSchema,
	/** True when any floor applied, the built-in one included. */
	floor: Schema.Boolean,
	/** The merge base the rating diffed from. */
	base: Schema.String.check(Schema.isPattern(BASE_SHA_PATTERN)),
	/** A sha256 prefix over the resolved rubric, the merged `risk` keys and the built-in floor version. */
	rules: Schema.String.check(Schema.isPattern(RULES_DIGEST_PATTERN)),
	/** Random per run; the grant must carry the nonce of the run's own `error`. */
	nonce: Schema.String.check(Schema.isPattern(NONCE_PATTERN)),
})
export type RiskDescription = typeof riskDescriptionSchema.Type
