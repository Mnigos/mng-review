import type { PullRequestInfo, ReviewUnit } from '@mng-review/domain'
import { fenceData, truncateText } from '../../../utils/fence.util'

const NONE = '(none)'

/** One `- path` line per file, or `(none)`. */
function toFileList(paths: readonly string[]): string {
	return paths.length > 0 ? paths.map(path => `- ${path}`).join('\n') : NONE
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

/** First message of a finder: its files, the change's title and description and the diff, cut short. */
export function toChangeMessage(
	paths: readonly string[],
	pr: Pick<PullRequestInfo, 'title' | 'body'>,
	diff: string,
	maxChars: number
): string {
	return [
		fenceData('Files in your scope:', toFileList(paths)),
		...toPullRequestBlock(pr),
		fenceData('Diff (base to head):', truncateText(diff, maxChars)),
		'The diff may be cut short. Use the tools to read more.',
	].join('\n\n')
}

/** First message of one unit of a deep review: the unit, every changed file and the unit's diff. */
export function toUnitMessage(
	unit: ReviewUnit,
	paths: readonly string[],
	pr: Pick<PullRequestInfo, 'title' | 'body'>,
	maxChars: number
): string {
	return [
		fenceData('Your unit:', unit.label),
		fenceData('All changed files:', toFileList(paths)),
		...toPullRequestBlock(pr),
		fenceData('Diff of your unit:', truncateText(unit.diff, maxChars)),
	].join('\n\n')
}
