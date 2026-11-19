import {
	budgetDiff,
	type ChangedFile,
	type DeclaredAgent,
} from '@mng-review/domain'
import { fenceData } from '../../../utils/fence.util'

/** The router reads at most this much of the diff. */
export const MAX_ROUTER_DIFF_CHARS = 24_000
const NONE = '(none)'

/** One line per changed file: status, path, the old path of a rename, and line counts. */
function toFileLine(file: ChangedFile): string {
	const from = file.oldPath === undefined ? '' : ` (from ${file.oldPath})`
	return `${file.status} ${file.path}${from} +${file.additions} -${file.deletions}`
}

/** One line per candidate agent with the triage sentence the router decides on. */
function toCandidateLine(agent: DeclaredAgent): string {
	return `- ${agent.name} (${agent.title}): ${agent.frontMatter.when.triage ?? ''}`
}

/**
 * The router's user message: the file list sorted by path, the candidates and the diff budgeted
 * across files to `MAX_ROUTER_DIFF_CHARS`, each fenced as data with a fence longer than any
 * backtick run inside. The same change always gives the same message.
 */
export function toRouterUserMessage(
	files: readonly ChangedFile[],
	candidates: readonly DeclaredAgent[],
	diff: string
): string {
	const fileList = files
		.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		.map(toFileLine)
		.join('\n')
	const candidateList = candidates.map(toCandidateLine).join('\n')
	return [
		fenceData('Changed files:', fileList || NONE),
		fenceData('Candidate agents:', candidateList || NONE),
		fenceData('Diff:', budgetDiff(diff, MAX_ROUTER_DIFF_CHARS).text || NONE),
	].join('\n\n')
}
