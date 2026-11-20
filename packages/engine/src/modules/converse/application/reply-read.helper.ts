import type { EvidenceRef } from '@mng-review/domain'
import type {
	ShownLines,
	ToolRef,
} from '../../review/application/repo-tools.types'

/** One shown line as a set key. */
function toReadKey(tree: ToolRef, path: string, line: number): string {
	return `${tree}\0${path}\0${line}`
}

/**
 * The lines a `read_file` showed whole, as keys for `isRangeRead`. They come from the tool's
 * arguments and the file it read, never from the output's text, which the repository shapes.
 */
export function getShownKeys(shown: ShownLines): string[] {
	const { start, end } = shown.lines
	return Array.from({ length: end - start + 1 }, (_, index) =>
		toReadKey(shown.ref, shown.path, start + index)
	)
}

/**
 * True when every line of the entry's range was shown in that tree. It stops at the first line not
 * shown, so a huge cited range costs no more than the lines read.
 */
export function isRangeRead(
	reads: ReadonlySet<string>,
	tree: ToolRef,
	ref: EvidenceRef
): boolean {
	for (let line = ref.lines.start; line <= ref.lines.end; line++)
		if (!reads.has(toReadKey(tree, ref.path, line))) return false
	return true
}
