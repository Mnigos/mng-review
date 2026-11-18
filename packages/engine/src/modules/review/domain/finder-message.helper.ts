import {
	type BudgetedFile,
	budgetDiff,
	type ChangedFile,
	type PullRequestInfo,
	type ReviewUnit,
} from '@mng-review/domain'
import { fenceData } from '../../../utils/fence.util'

const NONE = '(none)'

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

/** One line per file: path, line counts, and whether the review leaves it out or its diff is cut. */
function toFileList(
	files: readonly ChangedFile[],
	budgeted: readonly BudgetedFile[] = []
): string {
	if (files.length === 0) return NONE
	return files
		.map(file => {
			const skipped = file.skipped
				? `, left out of the review (${file.skipped})`
				: ''
			const shown = toShownNote(
				budgeted.find(entry => entry.path === file.path)
			)
			return `- ${file.path} (+${file.additions} -${file.deletions}${skipped}${shown})`
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
	const inScope = input.files.filter(file => input.scope.includes(file.path))
	const others = input.files.filter(file => !input.scope.includes(file.path))
	return [
		fenceData('Files in your scope:', toFileList(inScope, budget.files)),
		...(others.length > 0
			? [fenceData('Other changed files:', toFileList(others, budget.files))]
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
	return [
		fenceData('Your unit:', input.unit.label),
		fenceData('All changed files:', toFileList(input.files, budget.files)),
		...toPullRequestBlock(input.pr),
		fenceData('Diff of your unit:', budget.text || NONE),
		...toMissingNote(budget.files),
	].join('\n\n')
}
