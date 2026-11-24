import { parseRiskDescription } from '../risk-description.parser'
import type { RiskLevel, StatusLevel } from '../risk-description.schema'
import {
	GRANT_LEVELS,
	GRANT_STATE,
	THREAD_RAISE_SEVERITIES,
} from '../risk.constants'
import type { RiskSources, RiskStatus } from '../risk.types'

/** Levels by rank; `none` is below every rated level. */
const LEVEL_RANK = {
	none: 0,
	low: 1,
	medium: 2,
	high: 3,
} as const satisfies Record<StatusLevel, number>

/** The higher of two levels. */
export function getHigherLevel(
	first: StatusLevel,
	second: StatusLevel
): StatusLevel {
	return LEVEL_RANK[second] > LEVEL_RANK[first] ? second : first
}

/** The highest of `levels`, or `none` for an empty list. */
function getHighestLevel(levels: readonly StatusLevel[]): StatusLevel {
	return levels.reduce<StatusLevel>(getHigherLevel, 'none')
}

/**
 * The level a rating publishes: the highest of the model's level, every floor, Medium for a router
 * `risky`, High for a confirmed High or Critical bug in the threads, the marker's highest and the
 * held level. Nothing lowers it, so it is never below the held level.
 */
export function getCombinedLevel(sources: RiskSources): RiskLevel {
	const raised = sources.confirmedBugs.some(severity =>
		THREAD_RAISE_SEVERITIES.some(raise => raise === severity)
	)
	const level = getHighestLevel([
		sources.model,
		...sources.floors.map(floor => floor.level),
		sources.routerRisky ? 'medium' : 'none',
		raised ? 'high' : 'none',
		sources.markerHighest,
		sources.held,
	])
	return level === 'none' ? sources.model : level
}

/**
 * The level step 1's `error` carries: the higher of the held level and the level this run will
 * publish, or the held level alone when it will publish none.
 */
export function getStepOneLevel(
	held: StatusLevel,
	published?: RiskLevel
): StatusLevel {
	return published === undefined ? held : getHigherLevel(held, published)
}

/**
 * The held level: the highest level on any app status for `pullNumber`, `error` included, on any
 * of its heads. Statuses for another number, or whose description is not the exact form, add none.
 */
export function getHeldLevel(
	statuses: readonly RiskStatus[],
	pullNumber: number
): StatusLevel {
	return getHighestLevel(
		statuses
			.map(status => parseRiskDescription(status.description))
			.filter(description => description?.pr === pullNumber)
			.map(description => description?.level ?? 'none')
	)
}

/**
 * True when the status grants a merge for `pullNumber`: state `success`, the exact description
 * form, this number, level Low or Medium, and no floor applied. A `success` at High or `none`, or
 * with `floor=yes`, grants nothing: a floor touch always goes to the owner.
 */
export function isRiskGrant(status: RiskStatus, pullNumber: number): boolean {
	if (status.state !== GRANT_STATE) return false
	const description = parseRiskDescription(status.description)
	return (
		description?.pr === pullNumber &&
		!description.floor &&
		GRANT_LEVELS.some(level => level === description.level)
	)
}
