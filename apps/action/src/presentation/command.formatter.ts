import {
	type AuthorizedCommand,
	type CommandDecision,
	escapeMarkdown,
	toLogText,
} from '@mng-review/github'
import type { ReserveDecision } from '../application/command-run.types'

export const AUTHORIZE_SUMMARY_TITLE = '## MNG Review (command)'

/**
 * The step outputs the later jobs read. A denied command sets `authorized=false`, and with an
 * answer the denial job posts also `answer`, `answer_pull`, `answer_comment` and `answer_reason`.
 */
export function toAuthorizeOutputs(
	decision: CommandDecision
): Readonly<Record<string, string>> {
	if (decision.status === 'denied')
		return decision.answer &&
			decision.pullNumber !== undefined &&
			decision.commentId !== undefined
			? {
					authorized: 'false',
					answer: decision.answer,
					answer_pull: String(decision.pullNumber),
					answer_comment: String(decision.commentId),
					answer_reason: decision.reason,
				}
			: { authorized: 'false' }
	return {
		authorized: 'true',
		pull_number: String(decision.pullNumber),
		base_sha: decision.base,
		head_sha: decision.head,
		depth: decision.depth ?? '',
		agent: decision.agent ?? '',
	}
}

/** What an authorized command asks for, in words. */
function toRequestText(decision: AuthorizedCommand): string {
	if (decision.agent) return `agent ${decision.agent}`
	if (decision.depth) return `a ${decision.depth} review`
	return 'a review'
}

/** The decision in words, before it is made safe. */
function toDecisionText(decision: CommandDecision): string {
	if (decision.status === 'denied') return `command not run: ${decision.reason}`
	return `command authorized: ${toRequestText(decision)} of pull request #${decision.pullNumber}`
}

/** The one line the job log gets; a reason can carry GitHub's text, so it can never act as a command. */
export function formatAuthorizeLogLine(decision: CommandDecision): string {
	return toLogText(`mng-review: ${toDecisionText(decision)}`)
}

/** The job summary of the authorize job; the text is escaped, so it mentions and links nothing. */
export function formatAuthorizeSummary(decision: CommandDecision): string {
	return [
		AUTHORIZE_SUMMARY_TITLE,
		'',
		escapeMarkdown(toDecisionText(decision)),
		'',
	].join('\n')
}

/** The reserve step's log line: whether a manual run was counted and, if not, why. */
export function formatReserveLogLine(decision: ReserveDecision): string {
	const reason = decision.reserved ? '' : `: ${decision.reason}`
	return toLogText(`mng-review: reserve ${String(decision.reserved)}${reason}`)
}

/** The job summary of the reserve job. */
export function formatReserveSummary(decision: ReserveDecision): string {
	const text = decision.reserved
		? 'manual run counted; the review starts'
		: `manual run not counted: ${decision.reason}`
	return [AUTHORIZE_SUMMARY_TITLE, '', escapeMarkdown(text), ''].join('\n')
}
