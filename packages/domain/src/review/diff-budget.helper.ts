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

/** Characters a file of `size` gets from an even `share` of the `remaining` budget. */
function getAllowance(size: number, share: number, remaining: number): number {
	if (size <= share) return size
	if (share >= MIN_FILE_DIFF_CHARS) return share
	return size <= remaining ? size : 0
}

/**
 * Characters each file gets, by max-min fairness from the smallest diff up: a file that fits its
 * even share of what is left is kept whole, a larger one is cut to that share. When the share drops
 * below `MIN_FILE_DIFF_CHARS`, files are kept whole while they fit and the rest get nothing, so many
 * small files are not each cut to a useless stub.
 */
function toAllowances(
	blocks: readonly FileBlock[],
	maxChars: number
): number[] {
	const allowances = blocks.map(() => 0)
	const order = blocks
		.map((block, index) => ({ index, size: block.text.length }))
		.toSorted((a, b) => a.size - b.size || a.index - b.index)
	order.reduce((remaining, entry, rank) => {
		const share = Math.floor(remaining / (order.length - rank))
		const allowance = getAllowance(entry.size, share, remaining)
		allowances[entry.index] = allowance
		return remaining - allowance
	}, maxChars)
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
		files: budgeted.map(entry => entry.file),
	}
}
