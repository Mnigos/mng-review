import type { AnswerEntry } from '@mng-review/domain'
import {
	escapeCommentOpen,
	escapeMarkdown,
	toCodeSpan,
	toShort,
} from '../../../utils/markdown.util'
import { parseReplyMarker } from '../domain/publish-marker.parser'
import {
	MARKER_PREFIX,
	MARKER_VERSION,
	MAX_TEXT_CHARS,
	SHORT_SHA_LENGTH,
} from '../domain/publish.constants'
import type { ThreadReplyDecision } from '../domain/thread-reply.schema'
import {
	type BlobLinks,
	formatResolvedReply,
	toMarkerComment,
} from './thread-comment.formatter'

/** Evidence entries an `accepted` answer shows; the rest are left out. */
const MAX_SHOWN_EVIDENCE = 6
/** Characters of one evidence entry shown. */
const MAX_EVIDENCE_CHARS = 200

/** Model text for one line of a reply: cut, then escaped. */
function toReasonText(reason: string): string {
	return escapeMarkdown(toShort(reason, MAX_TEXT_CHARS))
}

/** The evidence the engine checked, each entry in a code span. */
function toEvidenceLines(evidence: readonly string[]): string[] {
	if (evidence.length === 0) return []
	const shown = evidence
		.slice(0, MAX_SHOWN_EVIDENCE)
		.map(entry =>
			toCodeSpan(escapeCommentOpen(toShort(entry, MAX_EVIDENCE_CHARS)))
		)
	return ['', `Evidence: ${shown.join(', ')}`]
}

/** The text of an answer other than `resolved`, without its marker. */
function toAnswerLines(
	decision: Exclude<ThreadReplyDecision, { readonly action: 'resolved' }>,
	head: string
): string[] {
	if (decision.action === 'accepted')
		return [
			`Accepted as intentional: ${toReasonText(decision.reason)} The bot no longer counts this thread as open.`,
			...toEvidenceLines(decision.evidence),
			'',
			`Memory candidate: ${toCodeSpan(escapeCommentOpen(toShort(decision.memory, MAX_TEXT_CHARS)))}. It counts only once a person merges it into ${toCodeSpan('.mng/MEMORY.md')}.`,
		]
	if (decision.action === 'still-found')
		return [`Still found at ${head}: ${toReasonText(decision.reason)}`]
	if (decision.action === 'disputed')
		return [
			`Not accepted: ${toReasonText(decision.reason)} A second disagreement goes to the owner.`,
		]
	if (decision.action === 'needs-owner')
		return [
			`This goes to the owner: ${toReasonText(decision.reason)} The bot no longer answers in this thread. An admin, or a login in ${toCodeSpan('commands.allow')}, resolves it to clear the pull request.`,
		]
	return [
		`Seen. Reply ${toCodeSpan('fixed')} after a commit that fixes it, or ${toCodeSpan('intentional because')} with the reason and a ${toCodeSpan('path:line')} that shows it.`,
	]
}

/**
 * The bot's answer to an author's reply, ending with the reply marker that names the comment it
 * answers and, with `entry`, every reply it names at the version its read saw; `unsettled` marks an
 * answer whose thread is reopened after it (`toSettledAnswer`). Every model text is escaped; the
 * memory candidate and the evidence sit in code spans.
 */
export function formatReplyAnswer(
	decision: ThreadReplyDecision,
	links: BlobLinks,
	reply: number,
	entry?: AnswerEntry,
	unsettled = false
): string {
	const answers = entry ? { answers: [entry] } : {}
	if (decision.action === 'resolved')
		return formatResolvedReply(decision.reason, links, reply, answers)
	const head = toCodeSpan(links.head.slice(0, SHORT_SHA_LENGTH))
	return [
		...toAnswerLines(decision, head),
		'',
		toMarkerComment('reply', {
			v: MARKER_VERSION,
			action: decision.action,
			commit: links.head,
			reply,
			...answers,
			...(unsettled ? { unsettled: true } : {}),
		}),
	].join('\n')
}

/**
 * An unsettled answer's body with `unsettled` dropped from its reply marker, or `undefined` when
 * the body ends with no unsettled reply marker.
 */
export function toSettledAnswer(body: string): string | undefined {
	const marker = parseReplyMarker(body)
	const start = body.lastIndexOf(`<!-- ${MARKER_PREFIX}reply `)
	if (marker?.unsettled !== true || start === -1) return undefined
	const { unsettled: _unsettled, ...settled } = marker
	return `${body.slice(0, start)}${toMarkerComment('reply', settled)}`
}
