import {
	type CommandDecision,
	escapeMarkdown,
	toLogText,
} from '@mng-review/github'

export const AUTHORIZE_SUMMARY_TITLE = '## MNG Review (command)'

/** The step outputs the review job reads; a denied command sets only `authorized=false`. */
export function toAuthorizeOutputs(
	decision: CommandDecision
): Readonly<Record<string, string>> {
	if (decision.status === 'denied') return { authorized: 'false' }
	return {
		authorized: 'true',
		pull_number: String(decision.pullNumber),
		base_sha: decision.base,
		head_sha: decision.head,
		depth: decision.depth ?? '',
		agent: decision.agent ?? '',
	}
}

/** The decision in words, before it is made safe. */
function toDecisionText(decision: CommandDecision): string {
	if (decision.status === 'denied') return `command not run: ${decision.reason}`
	const what = decision.agent
		? `agent ${decision.agent}`
		: decision.depth
			? 'a deep review'
			: 'a review'
	return `command authorized: ${what} of pull request #${decision.pullNumber}`
}

/** The one line the job log gets; a reason can carry GitHub's text, so it can never act as a command. */
export function formatAuthorizeLogLine(decision: CommandDecision): string {
	return toLogText(`mng-review: ${toDecisionText(decision)}`)
}

/** The job summary of the authorize job. */
export function formatAuthorizeSummary(decision: CommandDecision): string {
	return [
		AUTHORIZE_SUMMARY_TITLE,
		'',
		escapeMarkdown(toDecisionText(decision)),
		'',
	].join('\n')
}
