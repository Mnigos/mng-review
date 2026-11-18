import type { ChangedFile, DeclaredAgent } from '@mng-review/domain'
import { fenceData, truncateText } from '../../../utils/fence.util'

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
 * The router's user message: the file list, the candidates and the diff cut to
 * `MAX_ROUTER_DIFF_CHARS`, each fenced as data with a fence longer than any backtick run inside.
 */
export function toRouterUserMessage(
	files: readonly ChangedFile[],
	candidates: readonly DeclaredAgent[],
	diff: string
): string {
	const fileList = files.map(toFileLine).join('\n')
	const candidateList = candidates.map(toCandidateLine).join('\n')
	return [
		fenceData('Changed files:', fileList || NONE),
		fenceData('Candidate agents:', candidateList || NONE),
		fenceData('Diff:', truncateText(diff, MAX_ROUTER_DIFF_CHARS)),
	].join('\n\n')
}
