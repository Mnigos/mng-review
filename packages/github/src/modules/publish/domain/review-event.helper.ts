import type { ReviewConfig } from '@mng-review/domain'
import {
	type BotIdentity,
	GITHUB_ACTIONS_IDENTITY,
} from '../../../platform/bot-identity.helper'
import type { ReviewEvent } from '../../../platform/github-review.service'
import type { LenientList } from '../../../platform/list-completeness.context'
import type { Verdict } from '../presentation/summary-comment.formatter'
import type { CoverageGap } from './coverage-gap.helper'
import type { DecidedSummary, RenderedSummary } from './publish.types'

/**
 * What a run judged: a review of the change (push or command), a reply-only run that judged the
 * standing threads, or an offline run that judged nothing.
 */
export type ReviewRunKind = 'review' | 'reply' | 'offline'

/**
 * Whether the bot may approve: `allowed`, `preview` when `verdict.mode` turns approval off, or
 * `token` for the job token's `github-actions`, which GitHub refuses (422) unless the repository
 * lets Actions approve.
 */
export type Approval = 'allowed' | 'preview' | 'token'

/** What a push or command run knows when it picks its review's state. */
export interface ReviewedEvidence {
	readonly kind: 'review'
	readonly verdict: Verdict
	/** Open bug threads and bugs without a thread, for the body's reason. */
	readonly openBugs: number
	/** The pull request's head, read again before the event is picked, is the reviewed one. */
	readonly onHead: boolean
	/** Every planned agent could run: not a command that named one agent. */
	readonly full: boolean
	/**
	 * A planned run never reported, or a run or one of its units failed (an agent `error` too), or
	 * the endpoint failed, or publishing could not read the bot's threads again: the run cannot
	 * clear a change request, whatever its verdict.
	 */
	readonly failed: boolean
	/** The first reason from `getCoverageGaps` why the run does not cover the change; unset when it does. */
	readonly gap: CoverageGap | undefined
	/** The other reasons from `getCoverageGaps`, which the body names after `gap`. */
	readonly more?: readonly CoverageGap[]
	readonly approval: Approval
	/** The token's identity opened the pull request, so GitHub refuses it a review state. */
	readonly authored: boolean
	/** `false` when the write's head read found the pull request a draft, closed or merged. */
	readonly open?: boolean
	/** The write's last read of the pull request failed, so its head is unknown and the state stands. */
	readonly headUnknown?: boolean
	/** The lists a read of the run left a null node out of, so the state stands (`getIncompleteLists`). */
	readonly incomplete?: readonly LenientList[]
}

/** What a reply-only run knows: the standing verdict and whether it is on the summary's head. */
export interface RepliedEvidence {
	readonly kind: 'reply'
	readonly verdict: Verdict
	readonly openBugs: number
	/** The pull request's head, read again, is the run's head. */
	readonly current: boolean
	/** The run's head is the current head and the head of the summary's last full review. */
	readonly onHead: boolean
	/**
	 * The last full review had a run or unit that failed or never reported (the marker's `failed`),
	 * or publishing could not read the bot's threads again after the answers.
	 */
	readonly failed: boolean
	readonly authored: boolean
	/** The write's last read of the pull request failed, so its head is unknown and the state stands. */
	readonly headUnknown?: boolean
	/** The lists a read of the run left a null node out of, so the state stands (`getIncompleteLists`). */
	readonly incomplete?: readonly LenientList[]
}

/** An offline run judged nothing; it still reads who opened the pull request. */
export interface OfflineEvidence {
	readonly kind: 'offline'
	readonly authored: boolean
}

/** The evidence a run carries for its review's state. */
export type ReviewEvidence =
	| ReviewedEvidence
	| RepliedEvidence
	| OfflineEvidence

/** The evidence and what the pull request shows now: whether an owned change request stands. */
export type ReviewEventInput = ReviewEvidence & {
	readonly changesRequested: boolean
}

/** What a run does with the bot's review state. */
export interface ReviewDecision {
	/** The state a review the run posts carries. */
	readonly event: ReviewEvent
	/** The run has no evidence for a new state: it edits the newest review in whatever state it is. */
	readonly keep: boolean
	/** The write clears the owned change requests: they are dismissed after it. */
	readonly clears: boolean
}

/** The state a run without evidence for a new one keeps; a change request only with evidence for it. */
function toKept(changesRequested: boolean): ReviewDecision {
	return {
		event: changesRequested ? 'REQUEST_CHANGES' : 'COMMENT',
		keep: true,
		clears: false,
	}
}

/** A verdict that is evidence for a change request: an open confirmed bug or a thread waiting for the owner. */
export function isBlocking(verdict: Verdict): boolean {
	return verdict === 'needs fixes' || verdict === 'needs owner'
}

/** The decision before GitHub's rule that an author gets no review state. */
function toDecision(input: ReviewEventInput): ReviewDecision {
	if (input.kind === 'offline') return toKept(false)
	// A list that left a node out may hide a thread or review, so no read is evidence for a state.
	if (input.incomplete) return toKept(false)
	// A run whose head is not the current one never sets a state over the current head.
	if (!(input.kind === 'reply' ? input.current : input.onHead))
		return toKept(false)
	const blocking = isBlocking(input.verdict)
	if (input.kind === 'reply' && !input.onHead)
		return toKept(input.changesRequested && blocking)
	if (blocking) return { event: 'REQUEST_CHANGES', keep: false, clears: false }
	if (input.kind === 'reply')
		return input.verdict === 'ready' && !input.failed
			? { event: 'COMMENT', keep: false, clears: true }
			: toKept(false)
	if (!input.full || input.verdict !== 'ready' || input.failed)
		return toKept(false)
	const approves = input.gap === undefined && input.approval === 'allowed'
	// A draft, closed or merged pull request gets no approval, and the run has no evidence for another state.
	if (approves && input.open === false) return toKept(false)
	return { event: approves ? 'APPROVE' : 'COMMENT', keep: false, clears: true }
}

/**
 * A run changes the bot's review state only with evidence for the new one; otherwise it keeps it.
 * A review or a reply-only run on the current head (a reply-only run also on the summary's head)
 * that leaves a confirmed bug or a thread waiting for the owner requests changes. A full run that
 * finished `ready` on the current head with no failed run approves when it covered the change,
 * approving is allowed and the pull request is open and not a draft (else it keeps the state when
 * only that stops it), else comments, and either clears the owned change requests. A reply-only
 * run never approves: `ready` on the summary's head after a last full review with no failed run
 * comments and clears. Every other run keeps the state and posts `COMMENT`: a run whose head is not
 * the current one or could not be read, a single-agent, unfinished or failed run that found nothing
 * blocking, a run whose list reads left a node out, and an offline run. Only a reply-only run on the current head but off the summary's
 * head, with a blocking standing, keeps a standing owned change request as `REQUEST_CHANGES`. On a
 * pull request the bot opened every state is a `COMMENT`.
 */
export function getReviewDecision(input: ReviewEventInput): ReviewDecision {
	const decision = toDecision(input)
	if (!input.authored) return decision
	return { ...decision, event: 'COMMENT' }
}

/**
 * Whether the run may approve, decided by configuration and identity, so the bot never retries a
 * refused approval.
 */
export function getApproval(
	config: Pick<ReviewConfig, 'verdict'>,
	current: BotIdentity
): Approval {
	if (config.verdict.mode !== 'approve') return 'preview'
	if (current.login === GITHUB_ACTIONS_IDENTITY.login) return 'token'
	return 'allowed'
}

/** The pull request as the write reads it right before writing; unknown when the read failed. */
export interface LatestHead {
	readonly current: string | undefined
	readonly authored: boolean
	/** `false` when the pull request is a draft, closed or merged; unset when the read failed. */
	readonly open?: boolean
	/** The lists a read of the run, the write's own included, left a null node out of; unset for none. */
	readonly incomplete?: readonly LenientList[]
}

/** The evidence as the latest reads leave it: off the head, authored, or incomplete. */
function toLatestEvidence(
	evidence: ReviewEvidence,
	latest: LatestHead,
	head: string
): ReviewEvidence {
	const authored = evidence.authored || latest.authored
	const onCurrent = latest.current === head
	if (evidence.kind === 'offline') return { ...evidence, authored }
	const unknown = {
		...(latest.current === undefined ? { headUnknown: true } : {}),
		...(latest.incomplete ? { incomplete: latest.incomplete } : {}),
	}
	if (evidence.kind === 'review')
		return {
			...evidence,
			...unknown,
			authored,
			onHead: evidence.onHead && onCurrent,
			open: evidence.open !== false && latest.open !== false,
		}
	return {
		...evidence,
		...unknown,
		authored,
		current: evidence.current && onCurrent,
		onHead: evidence.onHead && onCurrent,
	}
}

/**
 * The render with the state its evidence gets, once the latest read of the pull request checked
 * that `head`, the reviewed one, is still its head; a render without evidence judged nothing.
 */
export function toDecidedSummary(
	rendered: RenderedSummary,
	changesRequested: boolean,
	latest: LatestHead,
	head: string
): DecidedSummary {
	const evidence = toLatestEvidence(
		rendered.evidence ?? { kind: 'offline', authored: false },
		latest,
		head
	)
	return {
		rendered: { ...rendered, evidence },
		decision: getReviewDecision({ ...evidence, changesRequested }),
	}
}
