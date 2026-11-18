import { parseFileDiffs } from './review-unit.parser'

/** Smallest cut of a file's diff worth inlining; below it the file is only named. */
export const MIN_FILE_DIFF_CHARS = 600

/** How much of one file's diff a budgeted diff carries. */
export type DiffShown = 'full' | 'cut' | 'none'

/** One file of a budgeted diff. */
export interface BudgetedFile {
	readonly path: string
	/** Characters of the file's whole diff. */
	readonly chars: number
	/** Characters of it the budgeted text carries, the cut marker excluded. */
	readonly shownChars: number
	readonly shown: DiffShown
}

/** A diff cut to a character budget across its files, and what each file kept. */
export interface BudgetedDiff {
	/** The kept file diffs in diff order; a cut file ends with a marker naming the rest. */
	readonly text: string
	/** Every file of the diff, in diff order. */
	readonly files: readonly BudgetedFile[]
}

/** One file's diff text. */
interface FileBlock {
	readonly path: string
	readonly text: string
}

/** The marker that ends a cut file diff. */
function toCutMarker(rest: number): string {
	return `[cut: ${rest} more characters of this file's diff]\n`
}

/** The start of a file diff, ended on a line boundary, at most `chars` long. */
function cutBlock(text: string, chars: number): string {
	const head = text.slice(0, chars)
	const lastLine = head.lastIndexOf('\n')
	return lastLine === -1 ? head : head.slice(0, lastLine + 1)
}

/** Where the allocation stands: the characters left and whether it fills whole files only. */
interface AllocationState {
	readonly remaining: number
	readonly wholeFilesOnly: boolean
}

/** Characters a file of `size` gets: whole when it fits, else its share or, filling whole files only, nothing. */
function getAllowance(
	size: number,
	share: number,
	state: AllocationState
): number {
	if (state.wholeFilesOnly) return size <= state.remaining ? size : 0
	return Math.min(size, share)
}

/**
 * Characters each file gets, by max-min fairness from the smallest diff up: a file that fits its
 * even share of what is left is kept whole, a larger one is cut to that share. Once the share drops
 * below `MIN_FILE_DIFF_CHARS`, the rest are kept whole while they fit and otherwise get nothing, so
 * many small files are not each cut to a useless stub; the allocation never switches back.
 */
function toAllowances(
	blocks: readonly FileBlock[],
	maxChars: number
): number[] {
	const allowances = blocks.map(() => 0)
	const order = blocks
		.map((block, index) => ({ index, size: block.text.length }))
		.toSorted((a, b) => a.size - b.size || a.index - b.index)
	order.reduce<AllocationState>(
		(state, entry, rank) => {
			const share = Math.floor(state.remaining / (order.length - rank))
			const wholeFilesOnly =
				state.wholeFilesOnly ||
				(entry.size > share && share < MIN_FILE_DIFF_CHARS)
			const allowance = getAllowance(entry.size, share, {
				...state,
				wholeFilesOnly,
			})
			allowances[entry.index] = allowance
			return { remaining: state.remaining - allowance, wholeFilesOnly }
		},
		{ remaining: maxChars, wholeFilesOnly: false }
	)
	return allowances
}

/** One file's budgeted text and what it kept. */
interface BudgetedBlock {
	readonly text: string
	readonly file: BudgetedFile
}

/** One file's budgeted text from its allowance; the cut marker fits inside the allowance. */
function toBudgetedBlock(block: FileBlock, allowance: number): BudgetedBlock {
	const { path } = block
	const chars = block.text.length
	if (allowance >= chars)
		return {
			text: block.text,
			file: { path, chars, shownChars: chars, shown: 'full' },
		}
	const kept =
		allowance === 0
			? ''
			: cutBlock(block.text, allowance - toCutMarker(chars).length)
	if (kept === '')
		return { text: '', file: { path, chars, shownChars: 0, shown: 'none' } }
	return {
		text: kept + toCutMarker(chars - kept.length),
		file: { path, chars, shownChars: kept.length, shown: 'cut' },
	}
}

/** The shown state of two diffs of one path: full only when both are. */
function toCombinedShown(a: DiffShown, b: DiffShown): DiffShown {
	if (a === 'full' && b === 'full') return 'full'
	if (a === 'none' && b === 'none') return 'none'
	return 'cut'
}

/**
 * One entry per path, in diff order: git prints a path twice when its type changes (a deletion and
 * an addition), and the reader needs one mark for the file.
 */
function toFilesByPath(files: readonly BudgetedFile[]): BudgetedFile[] {
	const byPath = new Map<string, BudgetedFile>()
	for (const file of files) {
		const earlier = byPath.get(file.path)
		byPath.set(
			file.path,
			earlier
				? {
						path: file.path,
						chars: earlier.chars + file.chars,
						shownChars: earlier.shownChars + file.shownChars,
						shown: toCombinedShown(earlier.shown, file.shown),
					}
				: file
		)
	}
	return [...byPath.values()]
}

/**
 * Cuts a unified diff to at most `maxChars` characters across its files instead of in diff order,
 * so a small file late in the order still shows. Every file is reported with what it kept; a file
 * that kept nothing must be named to the reader by the caller.
 */
export function budgetDiff(diff: string, maxChars: number): BudgetedDiff {
	const blocks = parseFileDiffs(diff).map(file => ({
		path: file.path,
		text: file.header + file.hunks.map(hunk => hunk.text).join(''),
	}))
	const allowances = toAllowances(blocks, maxChars)
	const budgeted = blocks.map((block, index) =>
		toBudgetedBlock(block, allowances[index] ?? 0)
	)
	return {
		text: budgeted.map(entry => entry.text).join(''),
		files: toFilesByPath(budgeted.map(entry => entry.file)),
	}
}
