import type { ReviewConfig } from '@mng-review/domain'
import {
	type BotIdentity,
	GITHUB_ACTIONS_IDENTITY,
} from '../../../platform/bot-identity.helper'
import type { ReviewEvent } from '../../../platform/github-review.service'
import type { Verdict } from '../presentation/summary-comment.formatter'

/**
 * What a run judged: a review of the change (push or command), a reply-only run that judged the
 * standing threads, or an offline run that judged nothing.
 */
export type ReviewRunKind = 'review' | 'reply' | 'offline'

/** What decides the state of a run's review. */
export interface ReviewEventInput {
	readonly kind: ReviewRunKind
	/** The verdict after the run: `needs owner`, `needs fixes`, `ready` or `incomplete`. */
	readonly verdict: Verdict
	/** The run does not stand for a full review: one agent, or a head that moved meanwhile. */
	readonly partial: boolean
	/**
	 * What is left that never blocks: for a review, the findings it kept (unverified, below the
	 * floor, nits); for a reply-only run, the bot's open unverified and nit threads.
	 */
	readonly findings: number
	/** `verdict.mode` is `approve` and the token's identity may approve (not the job token). */
	readonly approve: boolean
}

/**
 * The state of the run's review. `REQUEST_CHANGES` while a confirmed bug thread is open (new or
 * carried) or a thread waits for the owner, whatever the run; `APPROVE` only for a full, finished
 * review (or a reply-only run on a head the last full review finished) with nothing open and
 * nothing left to say, when approving is allowed; `COMMENT` otherwise. An offline run judged
 * nothing, so it keeps the state of the bot's newest review: `undefined`.
 */
export function getReviewEvent(
	input: ReviewEventInput
): ReviewEvent | undefined {
	if (input.kind === 'offline') return undefined
	if (input.verdict === 'needs owner' || input.verdict === 'needs fixes')
		return 'REQUEST_CHANGES'
	if (
		input.verdict === 'ready' &&
		!input.partial &&
		input.findings === 0 &&
		input.approve
	)
		return 'APPROVE'
	return 'COMMENT'
}

/**
 * True when the run may approve: `verdict.mode` is `approve` and the token's identity is not the job
 * token's `github-actions`, which GitHub refuses (422) unless the repository lets Actions approve.
 * Decided by identity, so the bot never retries a refused approval.
 */
export function canApprove(
	config: Pick<ReviewConfig, 'verdict'>,
	current: BotIdentity
): boolean {
	return (
		config.verdict.mode === 'approve' &&
		current.login !== GITHUB_ACTIONS_IDENTITY.login
	)
}
