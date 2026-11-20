import type { Finding } from '@mng-review/domain'
import type { ThreadKind } from './publish-marker.schema'
import { isSameProblem } from './publish-plan.helper'
import { MAX_RECHECKS } from './publish.constants'
import type {
	BotThread,
	PublishedFinding,
	RecheckProposal,
	ResolvedThread,
} from './publish.types'

/** Thread kinds the bot checks again; a nit is never resolved by the bot. */
const RECHECKED_KINDS = [
	'bug',
	'unverified',
] as const satisfies readonly ThreadKind[]

/**
 * The bot's open threads worth checking again at the head: a bug or unverified finding, posted on
 * an earlier commit, with no reply yet (a reply is the author's conversation, handled on its own),
 * and not found again by this run, which would show it still holds. Whether its file changed since
 * is checked against git afterwards.
 */
export function getRecheckCandidates(
	threads: readonly BotThread[],
	published: readonly PublishedFinding[],
	head: string
): BotThread[] {
	const kinds: readonly ThreadKind[] = RECHECKED_KINDS
	return threads.filter(
		thread =>
			!thread.resolved &&
			kinds.includes(thread.marker.kind) &&
			thread.replies === 0 &&
			thread.commit !== undefined &&
			thread.commit !== head &&
			!published.some(entry => isSameProblem(entry.finding, thread))
	)
}

/**
 * The finding a thread reported, rebuilt from its marker for the validator: place, severity,
 * title, and trigger and impact when the marker has them (markers before they did carry the title
 * only).
 */
export function toThreadFinding(thread: BotThread): Finding {
	const { marker } = thread
	return {
		path: thread.path,
		line: thread.line ?? thread.originalLine ?? marker.line,
		severity: marker.severity,
		title: marker.title,
		trigger: marker.trigger ?? marker.title,
		impact: marker.impact ?? marker.title,
		evidence: [],
		kind: 'bug',
		agents: [marker.agent],
		models: [],
		fingerprint: marker.fingerprint,
	}
}

/**
 * The candidates starting at a batch that moves with every run, so with more than `MAX_RECHECKS`
 * of them every one is checked within a few runs instead of the same first batch each time.
 */
export function getRotated<TItem>(
	items: readonly TItem[],
	rotation: number
): TItem[] {
	if (items.length <= MAX_RECHECKS) return [...items]
	const start = (rotation * MAX_RECHECKS) % items.length
	return [...items.slice(start), ...items.slice(0, start)]
}

/**
 * The proposals that still hold in a fresh read of the bot's threads, each with its thread: the
 * thread exists, carries the proposal's fingerprint, is a bug or unverified thread, is open, has
 * no reply, and was posted on a commit other than the head. Any other proposal is dropped, and a
 * thread proposed twice counts once.
 */
export function getApplicableProposals(
	proposals: readonly RecheckProposal[],
	threads: readonly BotThread[],
	head: string
): ResolvedThread[] {
	const kinds: readonly ThreadKind[] = RECHECKED_KINDS
	const byId = new Map(threads.map(thread => [thread.id, thread]))
	return proposals.flatMap((proposal, index) => {
		const thread = byId.get(proposal.threadId)
		if (
			!thread ||
			proposals.findIndex(other => other.threadId === proposal.threadId) !==
				index ||
			thread.marker.fingerprint !== proposal.fingerprint ||
			!kinds.includes(thread.marker.kind) ||
			thread.resolved ||
			thread.replies > 0 ||
			thread.commit === undefined ||
			thread.commit === head
		)
			return []
		return [{ thread, reason: proposal.reason }]
	})
}
