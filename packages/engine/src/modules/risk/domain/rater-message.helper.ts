import {
	type BudgetedFile,
	budgetDiff,
	type ChangedFile,
	type FloorHit,
	type KeptFinding,
} from '@mng-review/domain'
import { fenceData } from '../../../utils/fence.util'
import type { RaterInput } from './risk-rating.types'

const NONE = '(none)'

/** What the rater's first message is built from; never the title, description or commit messages. */
export interface RaterMessageInput extends RaterInput {
	/** Every changed file, `skip.paths` and binaries included. */
	readonly files: readonly ChangedFile[]
	/** The diff of every changed file. */
	readonly diff: string
	readonly maxChars: number
	readonly findings: readonly KeptFinding[]
}

/** What a file line says about the file's diff in the message. */
function toShownNote(file: BudgetedFile | undefined): string {
	if (!file || file.shown === 'full') return ''
	if (file.shown === 'none') return ', diff not shown'
	return `, diff cut to ${file.shownChars} of ${file.chars} characters`
}

/** One line per file: path, status, line counts, a skip, a binary, and a cut or missing diff. */
function toFileList(
	files: readonly ChangedFile[],
	budgeted: readonly BudgetedFile[]
): string {
	if (files.length === 0) return NONE
	return files
		.map(file => {
			const from = file.oldPath ? ` from ${file.oldPath}` : ''
			const skipped = file.skipped
				? `, left out of the review (${file.skipped})`
				: ''
			const binary = file.binary ? ', binary' : ''
			const shown = toShownNote(
				budgeted.find(entry => entry.path === file.path)
			)
			return `- ${file.path} (${file.status}${from}, +${file.additions} -${file.deletions}${skipped}${binary}${shown})`
		})
		.join('\n')
}

/** One line per floor that applied: its name, level, paths and summed line counts. */
function toFloorList(floors: readonly FloorHit[]): string {
	if (floors.length === 0) return NONE
	return floors
		.map(
			floor =>
				`- ${floor.name}: ${floor.level}, ${floor.paths.length} file(s), +${floor.added} -${floor.deleted}`
		)
		.join('\n')
}

/** One line per kept finding: severity, kind, place, title and the validator's answer. */
function toFindingList(findings: readonly KeptFinding[]): string {
	if (findings.length === 0) return NONE
	return findings
		.map(finding => {
			const status = finding.validation?.status ?? 'not validated'
			return `- ${finding.severity} ${finding.kind} at ${finding.path}:${finding.line} (${status}): ${finding.title}`
		})
		.join('\n')
}

/** The instruction under a diff that cut or left out files; nothing when every file is whole. */
function toMissingNote(budgeted: readonly BudgetedFile[]): string[] {
	const missing = budgeted.filter(file => file.shown !== 'full').length
	if (missing === 0) return []
	return [
		`The diff above cuts or leaves out ${missing} of ${budgeted.length} files; the file list marks them. Read every one of them in full before you answer, or the change stays unrated.`,
	]
}

/**
 * The rater's first message: the rubric, every changed file, the floors that applied, the kept
 * findings, the earlier rating and the diff budgeted across files. It holds no title, description,
 * comment or commit message.
 */
export function toRaterMessage(input: RaterMessageInput): string {
	const budget = budgetDiff(input.diff, input.maxChars)
	const rubric = input.rubric.trim()
	return [
		fenceData("The repository's risk rubric:", rubric || NONE),
		fenceData('Changed files:', toFileList(input.files, budget.files)),
		fenceData('Floors the engine applied:', toFloorList(input.floors)),
		fenceData('Findings the reviewers kept:', toFindingList(input.findings)),
		`The highest level an earlier rating of this pull request published: ${input.previous}. The engine never lowers a rating.`,
		fenceData('Diff (base to head):', budget.text || NONE),
		...toMissingNote(budget.files),
	].join('\n\n')
}
