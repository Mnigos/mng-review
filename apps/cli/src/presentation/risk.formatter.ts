import type { FloorHit } from '@mng-review/domain'
import type { RiskRating } from '@mng-review/engine'

/** Characters of a commit a rating line shows. */
const SHORT_SHA = 7

/** One line per floor that applied: its name, level, file count and line counts. */
function toFloorLines(floors: readonly FloorHit[]): string[] {
	return floors.map(
		floor =>
			`  floor ${floor.name}: ${floor.level} (${floor.paths.length} file(s), +${floor.added} -${floor.deleted})`
	)
}

/**
 * The rating as text: the level and what raised it above the rater's, or why the change is not
 * rated, then the reasons, the diff ranges, the floors that applied and the commits it names.
 */
export function toRiskLines(rating: RiskRating): string[] {
	const bound = `head ${rating.head.slice(0, SHORT_SHA)}, base ${rating.base.slice(0, SHORT_SHA)}, rules ${rating.rules}`
	if (rating.status === 'unrated')
		return [
			'',
			`Risk: not rated (${rating.reason}): ${rating.detail}`,
			...toFloorLines(rating.floors),
			`  ${bound}`,
		]
	const raised =
		rating.level === rating.model
			? ''
			: ` (the rater said ${rating.model}; raised by floors or findings)`
	return [
		'',
		`Risk: ${rating.level}${raised}, rated by ${rating.rater}`,
		...rating.reasons.map(reason => `  - ${reason}`),
		...(rating.refs.length > 0 ? [`  refs: ${rating.refs.join(', ')}`] : []),
		...(rating.up ? [`  higher if: ${rating.up}`] : []),
		...(rating.down ? [`  lower if: ${rating.down}`] : []),
		...toFloorLines(rating.floors),
		`  ${bound}`,
	]
}
