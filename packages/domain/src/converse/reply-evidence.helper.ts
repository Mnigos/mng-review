import type { LineRange } from '../review/line-range.parser'
import type { EvidenceRef } from './reply-evidence.parser'

/** What the engine read about an evidence entry's file. */
export interface EvidenceFile {
	/** Lines of the file at the head; `undefined` when it is missing there. */
	readonly headLines: number | undefined
	/** Lines of the file at the merge base; `undefined` when it is missing there. */
	readonly baseLines: number | undefined
	/** Head lines the pull request added to the file. */
	readonly added: readonly LineRange[]
}

/** Lines of a file's text; a final line break ends the last line rather than starting another. */
export function getLineCount(text: string): number {
	if (text === '') return 0
	const lines = text.split('\n').length
	return text.endsWith('\n') ? lines - 1 : lines
}

/** True when two line ranges share a line. */
function isOverlapping(a: LineRange, b: LineRange): boolean {
	return a.start <= b.end && b.start <= a.end
}

/**
 * True when the entry points at code the pull request did not write. No cited line may be one the
 * pull request added, so a line number that also exists at the merge base never clears added code.
 * Lines within the head's end pass; lines past it pass when they exist at the merge base.
 */
export function isEvidenceInCode(
	ref: EvidenceRef,
	file: EvidenceFile
): boolean {
	const { end } = ref.lines
	if (file.added.some(range => isOverlapping(range, ref.lines))) return false
	if (file.headLines !== undefined && end <= file.headLines) return true
	return file.baseLines !== undefined && end <= file.baseLines
}
