import {
	type BudgetedFile,
	budgetDiff,
	type ChangedFile,
	parseFileDiffs,
	type PullRequestInfo,
	type ReviewUnit,
} from '@mng-review/domain'
import { fenceData } from '../../../utils/fence.util'
import { MAX_LISTED_UNIT_CHARS, MAX_LISTED_UNITS } from './review.constants'

const NONE = '(none)'

/**
 * The code each file's hunks change, by path: the function or block git names after each `@@`,
 * once each, at most `MAX_LISTED_UNITS` per file, each cut to `MAX_LISTED_UNIT_CHARS`. It tells a
 * finder what a file it has not seen changes, so it can choose what to read.
 */
export function getChangedUnits(diff: string): ReadonlyMap<string, string[]> {
	return new Map(
		parseFileDiffs(diff).map(file => [
			file.path,
			[
				...new Set(
					file.hunks
						.map(hunk => hunk.context.slice(0, MAX_LISTED_UNIT_CHARS))
						.filter(context => context !== '')
				),
			].slice(0, MAX_LISTED_UNITS),
		])
	)
}

/** The change a finder's first message describes. */
export interface ChangeMessageInput {
	/** Every changed file, skipped ones included. */
	readonly files: readonly ChangedFile[]
	/** Paths the finder reviews. */
	readonly scope: readonly string[]
	readonly pr: Pick<PullRequestInfo, 'title' | 'body'>
	readonly diff: string
	readonly maxChars: number
}

/** What a file line says about the file's diff in the message. */
function toShownNote(file: BudgetedFile | undefined): string {
	if (!file || file.shown === 'full') return ''
	if (file.shown === 'none') return ', diff not shown'
	return `, diff cut to ${file.shownChars} of ${file.chars} characters`
}

/** A file list without a diff: no file is marked cut and none names its changed code. */

/** What a file list knows about the diff: what each file kept, and the code each file changes. */
interface FileListDiff {
	readonly budgeted: readonly BudgetedFile[]
	readonly units: ReadonlyMap<string, readonly string[]>
}

/** The changed code a file line names: only for a file whose diff the message does not show whole. */
function toUnitsNote(
	file: BudgetedFile | undefined,
	units: readonly string[] | undefined
): string {
	if (!file || file.shown === 'full' || !units || units.length === 0) return ''
	return `; changes ${units.map(unit => `\`${unit}\``).join(', ')}`
}

/**
 * One line per file: path, line counts, whether the review leaves it out or its diff is cut, and
 * for a cut or left-out diff the code it changes.
 */
function toFileList(files: readonly ChangedFile[], diff: FileListDiff): string {
	if (files.length === 0) return NONE
	return files
		.map(file => {
			const skipped = file.skipped
				? `, left out of the review (${file.skipped})`
				: ''
			const budgeted = diff.budgeted.find(entry => entry.path === file.path)
			const shown = toShownNote(budgeted)
			const units = toUnitsNote(budgeted, diff.units.get(file.path))
			return `- ${file.path} (+${file.additions} -${file.deletions}${skipped}${shown})${units}`
		})
		.join('\n')
}

/** The instruction under a diff that left files out or cut them; nothing when every file is whole. */
function toMissingNote(budgeted: readonly BudgetedFile[]): string[] {
	const missing = budgeted.filter(file => file.shown !== 'full').length
	if (missing === 0) return []
	return [
		`The diff above cuts or leaves out ${missing} of ${budgeted.length} files; the file list marks them. They are part of the change. Read each one you have not seen with \`diff(path)\` (a long diff comes in parts; pass the offset its end names) or \`read_file\` before you answer; do not assume they are fine.`,
	]
}

/** The change's title and description, fenced; nothing when it has neither. */
export function toPullRequestBlock(
	pr: Pick<PullRequestInfo, 'title' | 'body'>
): string[] {
	if (!(pr.title || pr.body)) return []
	return [
		fenceData(
			'Title and description of the change:',
			`${pr.title ?? ''}\n\n${pr.body ?? ''}`.trim()
		),
	]
}

/** `.mng/CONTEXT.md` as a section of a system prompt; nothing when it is empty. */
export function toContextNotes(context: string | undefined): string[] {
	const notes = context?.trim()
	return notes ? [`Notes from the repository's maintainers:\n\n${notes}`] : []
}

/**
 * First message of a finder: its files and every other changed file with sizes, the change's title
 * and description, and the diff budgeted across files. Files the budget left out are named.
 */
export function toChangeMessage(input: ChangeMessageInput): string {
	const budget = budgetDiff(input.diff, input.maxChars)
	const listed = { budgeted: budget.files, units: getChangedUnits(input.diff) }
	const inScope = input.files.filter(file => input.scope.includes(file.path))
	const others = input.files.filter(file => !input.scope.includes(file.path))
	return [
		fenceData('Files in your scope:', toFileList(inScope, listed)),
		...(others.length > 0
			? [fenceData('Other changed files:', toFileList(others, listed))]
			: []),
		...toPullRequestBlock(input.pr),
		fenceData('Diff (base to head):', budget.text || NONE),
		...toMissingNote(budget.files),
	].join('\n\n')
}

/** The unit a deep-review sub-agent gets and the change around it. */
export interface UnitMessageInput extends Omit<
	ChangeMessageInput,
	'scope' | 'diff'
> {
	readonly unit: ReviewUnit
}

/** First message of one unit of a deep review: the unit, every changed file and the unit's diff. */
export function toUnitMessage(input: UnitMessageInput): string {
	const budget = budgetDiff(input.unit.diff, input.maxChars)
	const listed = {
		budgeted: budget.files,
		units: getChangedUnits(input.unit.diff),
	}
	return [
		fenceData('Your unit:', input.unit.label),
		fenceData('All changed files:', toFileList(input.files, listed)),
		...toPullRequestBlock(input.pr),
		fenceData('Diff of your unit:', budget.text || NONE),
		...toMissingNote(budget.files),
	].join('\n\n')
}
