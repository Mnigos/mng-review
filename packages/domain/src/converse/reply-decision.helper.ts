import type { Change } from '../change/change.types'
import type { ReviewConfig } from '../config/review-config.schema'
import { getSeverityRank } from '../findings/finding.helper'
import type { Finding } from '../findings/finding.types'
import { matchesAtEitherPath } from '../routing/helpers/agent-selection.helper'
import type { Validation } from '../validation/validation.types'
import type { ReplyAnswer } from './reply-answer.schema'
import { toCutLine, toOneLine, toPlainText } from './reply-text.helper'
import {
	MEMORY_REASON_MAX_CHARS,
	REPLY_REASON_MAX_CHARS,
} from './reply.constants'
import type {
	IntentionalLimit,
	ReplyClaim,
	ReplyDecision,
	ReplyItem,
} from './reply.types'

/** What `toReplyDecision` reads besides the claim. */
export interface ReplyDecisionInput {
	readonly item: ReplyItem
	readonly claim: ReplyClaim
	readonly config: ReviewConfig
	readonly limit: IntentionalLimit
	/** The evidence entries that passed the engine's check; an `intentional` claim needs one. */
	readonly checkedEvidence: readonly string[]
	/** `fixed` only: the validator's answer at the head, when it gave one. */
	readonly recheck?: Validation
	/** `fixed` only: a commit since the thread's commit changed its file. */
	readonly commitSince: boolean
}

const NO_COMMIT_SINCE = 'no commit since has changed this file'
const NOT_RECHECKED = 'the finding could not be checked again at the head'
const SECOND_DISAGREEMENT =
	'the reason was disputed before; the owner decides now'
const MISSING_EVIDENCE =
	'no evidence cites lines that were read in the code and that this pull request did not add'
const UNNAMED_REASON = 'the author gave a reason'
const UNHELD_REASON = 'the reason does not hold against the code'

/**
 * Why an `intentional` reply on this finding goes to the owner whatever its reason: a `critical`
 * finding, a file under `risk_paths` (at its new or, for a rename, old path, as the plan matches),
 * or a severity above `disputes.accept_intentional_up_to`. The severity is the one in the bot's
 * marker.
 */
export function getIntentionalLimit(
	finding: Pick<Finding, 'path' | 'severity'>,
	config: ReviewConfig,
	change: Pick<Change, 'files'>
): IntentionalLimit {
	if (finding.severity === 'critical') return 'critical'
	const file = change.files.find(
		entry => entry.path === finding.path || entry.oldPath === finding.path
	) ?? {
		path: finding.path,
	}
	if (matchesAtEitherPath(file, config.risk_paths)) return 'risk_paths'
	const upTo = config.disputes.accept_intentional_up_to
	if (getSeverityRank(finding.severity) > getSeverityRank(upTo))
		return 'severity'
	return 'ok'
}

/** The model's answer as a claim; `holds` and `failedPremise` only for `intentional`. */
export function toReplyClaim(answer: ReplyAnswer): ReplyClaim {
	const intentional = answer.claim === 'intentional'
	return {
		claim: answer.claim,
		evidence: answer.evidence,
		...(intentional ? { holds: answer.holds } : {}),
		...(answer.reason ? { reason: answer.reason } : {}),
		...(intentional && answer.failed_premise
			? { failedPremise: answer.failed_premise }
			: {}),
	}
}

/**
 * One line for `.mng/MEMORY.md`: the finding's path and the model's reason, the reason cut to
 * `MEMORY_REASON_MAX_CHARS`. It never holds the reply's text, and both parts are `toPlainText`, so
 * wherever it is rendered it opens no link, image, markup, code span or mention.
 */
export function toMemoryCandidate(
	finding: Pick<Finding, 'path'>,
	reason: string
): string {
	const path = toOneLine(toPlainText(finding.path))
	return `${path}: ${toCutLine(toPlainText(reason), MEMORY_REASON_MAX_CHARS)}`
}

/** Why a limit sends an `intentional` reply to the owner. */
function toLimitReason(
	limit: Exclude<IntentionalLimit, 'ok'>,
	item: ReplyItem,
	config: ReviewConfig
): string {
	if (limit === 'critical') return 'a critical finding is the owner’s call'
	if (limit === 'risk_paths') return `${item.finding.path} is under risk_paths`
	return `${item.finding.severity} is above disputes.accept_intentional_up_to (${config.disputes.accept_intentional_up_to})`
}

/** The answer to a `fixed` reply, from the commit check and the validator's answer at the head. */
function toFixedDecision(input: ReplyDecisionInput): ReplyDecision {
	const { recheck } = input
	if (!input.commitSince)
		return { action: 'still-found', reason: NO_COMMIT_SINCE }
	if (recheck?.status === 'rejected')
		return { action: 'resolved', reason: recheck.reason }
	if (recheck === undefined)
		return { action: 'still-found', reason: NOT_RECHECKED }
	if (recheck.status === 'unvalidated')
		return {
			action: 'still-found',
			reason: `${NOT_RECHECKED}: ${recheck.error}`,
		}
	return { action: 'still-found', reason: recheck.reason }
}

/** The decision of `toReplyDecision` before its reason is cut. */
function getReplyDecision(input: ReplyDecisionInput): ReplyDecision {
	const { item, claim, config, limit } = input
	if (claim.claim === 'unclear') return { action: 'seen' }
	if (claim.claim === 'fixed') return toFixedDecision(input)
	if (limit !== 'ok')
		return { action: 'needs-owner', reason: toLimitReason(limit, item, config) }
	if (claim.holds && input.checkedEvidence.length > 0) {
		const reason = claim.reason ?? item.finding.title
		return {
			action: 'accepted',
			reason: claim.reason ?? UNNAMED_REASON,
			memory: toMemoryCandidate(item.finding, reason),
			evidence: input.checkedEvidence,
		}
	}
	if (item.disputes >= config.disputes.max_rounds)
		return { action: 'needs-owner', reason: SECOND_DISAGREEMENT }
	if (!claim.holds)
		return {
			action: 'disputed',
			reason: claim.failedPremise ?? UNHELD_REASON,
		}
	return { action: 'disputed', reason: MISSING_EVIDENCE }
}

/**
 * Decides on one reply; the first rule that matches wins. `unclear` is only seen. `fixed` resolves
 * only when a commit since the thread's commit changed the file and the validator rejects the
 * finding at the head; otherwise the finding is still found, with no dispute round. `intentional`
 * goes to the owner past a limit, is accepted when its reason holds and checked evidence backs it,
 * goes to the owner once `disputes.max_rounds` disputes were answered, and is disputed otherwise.
 * Every reason is one line of at most `REPLY_REASON_MAX_CHARS`.
 */
export function toReplyDecision(input: ReplyDecisionInput): ReplyDecision {
	const decision = getReplyDecision(input)
	if (decision.action === 'seen') return decision
	return {
		...decision,
		reason: toCutLine(decision.reason, REPLY_REASON_MAX_CHARS),
	}
}
