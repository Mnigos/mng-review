import type { FloorHit } from '@mng-review/domain'
import { escapeMarkdown, toCodeSpan } from '../../../utils/markdown.util'
import { toMarkerComment } from '../../publish/presentation/thread-comment.formatter'
import type { RiskMarker } from '../domain/risk-marker.schema'
import { RISK_MARKER_TEXT } from '../domain/risk.constants'
import type { RatingBlock } from '../domain/risk.types'

/** One floor with its paths' summed line counts; the counts decide nothing. */
function toFloorLine(floor: FloorHit): string {
	return `- floor ${toCodeSpan(floor.name)} (${floor.level}): ${floor.paths.length} path(s), +${floor.added} −${floor.deleted}`
}

/**
 * The rating block of a review body: the level and why, or why the head is not rated, then the
 * floors that applied. Every model or repository text is escaped, so it can neither format the
 * page nor open an HTML comment.
 */
export function formatRatingBlock(block: RatingBlock): string[] {
	const floors = block.floors.map(toFloorLine)
	if (block.status === 'unrated')
		return [
			'',
			`**Risk: not rated** (${block.reason}): ${escapeMarkdown(block.detail)}. The owner merges.`,
			...floors,
		]
	const source = block.reused ? ' (same tree and base as a rated head)' : ''
	return [
		'',
		`**Risk: ${block.level}**${source}`,
		...block.reasons.map(reason => `- ${escapeMarkdown(reason)}`),
		...floors,
	]
}

/** The risk comment's body: one line for readers and the hidden marker last. */
export function formatRiskComment(marker: RiskMarker): string {
	return `${RISK_MARKER_TEXT}\n\n${toMarkerComment('risk', marker)}`
}
