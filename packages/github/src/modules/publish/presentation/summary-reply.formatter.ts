import type { SummaryMarker } from '../domain/publish-marker.schema'
import type { BotThread, SummaryComment } from '../domain/publish.types'
import {
	formatStatusComment,
	MAX_LIST_ITEMS,
	MAX_SUMMARY_CHARS,
	SHORT_LIST_ITEMS,
	toSummaryWithMarker,
	toWaitingSection,
	type Verdict,
} from './summary-comment.formatter'
import type { BlobLinks } from './thread-comment.formatter'

/** The verdict and the open bug count of a summary's verdict line; the rest of the line stays. */
const VERDICT_LINE =
	/^\*\*Verdict: [^*\n]*\*\*([^\n]*?)\d+ open bug thread\(s\)/mu
/** The waiting section a summary carries, from its blank line to its last list line. */
const WAITING_SECTION = /\n\nWaiting for the owner \(\d+\):\n(?:\n- [^\n]*)+/u
/** What a summary says when a reply-only run finds none to edit. */
const REPLIED_STATUS =
	'Replies in the threads were answered; no review has been summarized on this pull request yet.'

/** What a reply-only run changes in the summary. */
export interface RepliedSummaryInput {
	readonly verdict: Verdict
	readonly openBugs: number
	/** The threads that wait for the owner after the run. */
	readonly waiting: readonly BotThread[]
	readonly marker: SummaryMarker
	readonly links: BlobLinks
}

/** The body with its verdict line and waiting list replaced, the list cut to `limit` entries. */
function toRepliedBody(
	body: string,
	input: RepliedSummaryInput,
	limit: number
): string {
	const lines = toWaitingSection(input.waiting, limit)
	// The section starts with its blank line, as WAITING_SECTION matches it.
	const section = lines.length === 0 ? '' : `\n${lines.join('\n')}`
	const withVerdict = body.replace(
		VERDICT_LINE,
		(_line, between: string) =>
			`**Verdict: ${input.verdict}**${between}${input.openBugs} open bug thread(s)`
	)
	if (WAITING_SECTION.test(withVerdict))
		return withVerdict.replace(WAITING_SECTION, () => section)
	const verdictLine = VERDICT_LINE.exec(withVerdict)
	if (!verdictLine || section === '') return withVerdict
	const end = withVerdict.indexOf('\n', verdictLine.index)
	const at = end === -1 ? withVerdict.length : end
	return `${withVerdict.slice(0, at)}${section}${withVerdict.slice(at)}`
}

/**
 * The summary after a reply-only run: the body as it was except the verdict, the open bug count of
 * the verdict line and the list of threads waiting for the owner, which shrinks until the body
 * fits `MAX_SUMMARY_CHARS`, with the new marker. The run count in the verdict line stays, as the marker's does. With no summary to edit, a status summary
 * says that replies were answered.
 */
export function formatRepliedSummary(
	current: Pick<SummaryComment, 'body'> | undefined,
	input: RepliedSummaryInput
): string {
	if (!current)
		return formatStatusComment(REPLIED_STATUS, input.marker, input.links)
	const full = toRepliedBody(current.body, input, MAX_LIST_ITEMS)
	if (full.length <= MAX_SUMMARY_CHARS)
		return toSummaryWithMarker(full, input.marker)
	const short = toRepliedBody(current.body, input, SHORT_LIST_ITEMS)
	// Paths are not cut, so even three entries can be too long; then only the count stays.
	const body =
		short.length <= MAX_SUMMARY_CHARS
			? short
			: toRepliedBody(current.body, input, 0)
	return toSummaryWithMarker(body, input.marker)
}
