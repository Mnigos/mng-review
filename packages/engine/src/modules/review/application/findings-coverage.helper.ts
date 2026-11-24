import { addLaterFindings, type ParsedFindings } from '@mng-review/domain'
import type { LoopCoverage } from './agent-loop.types'

/**
 * The main reviewer's method check: the changed files it must read before it answers. A
 * continuation adds only findings that do not repeat the first answer's.
 */
export function toFindingsCoverage(
	paths: readonly string[],
	changed: ReadonlyMap<string, readonly number[]> = new Map()
): LoopCoverage<ParsedFindings> {
	return {
		paths,
		changed,
		merge: addLaterFindings,
	}
}
