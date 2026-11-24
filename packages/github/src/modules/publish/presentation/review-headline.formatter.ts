import type { ReviewEvent } from '../../../platform/github-review.service'
import type { CoverageGap } from '../domain/coverage-gap.helper'
import type { DecidedSummary } from '../domain/publish.types'
import type {
	ReviewedEvidence,
	ReviewEvidence,
} from '../domain/review-event.helper'

/** The words the headline opens with for each review state, matching what GitHub shows. */
const STATE_LABEL = {
	APPROVE: 'Approved',
	REQUEST_CHANGES: 'Changes requested',
	COMMENT: 'Comment',
} as const satisfies Record<ReviewEvent, string>
/** A headline an earlier write put first, replaced by each write. */
const HEADLINE = /^\*\*(?:Approved|Changes requested|Comment)\.\*\* [^\n]*\n\n/u

/** The state a write left and why. */
export interface HeadlineInput {
	readonly event: ReviewEvent
	readonly evidence: ReviewEvidence
	/** The run kept the state it found instead of setting one. */
	readonly keep: boolean
}

/** Why the run's coverage falls short, with the counts the engine recorded. */
function toGapText(gap: CoverageGap): string {
	if (gap.kind === 'no-reviewer')
		return 'the main reviewer did not run (a quick review skips it), so no run read the whole change.'
	if (gap.kind === 'skipped') {
		const skipped = gap.tooLarge + gap.binary
		if (gap.binary === 0)
			return `${skipped} of ${gap.files} changed files were too large to review.`
		if (gap.tooLarge === 0)
			return `${skipped} of ${gap.files} changed files are binary and were not reviewed.`
		return `${skipped} of ${gap.files} changed files were too large or binary to review.`
	}
	if (gap.kind === 'budget')
		return 'the review stopped at its token budget before reading every changed file.'
	if (gap.kind === 'failed')
		return `${gap.failed} of ${gap.runs} review run(s) failed or did not report.`
	if (gap.kind === 'cap')
		return `reading every changed file needs more than the ${gap.cap.toLocaleString('en-US')} tokens \`limits.tokens_per_run\` lets the finders plan, so the review read only what fit.`
	if (gap.kind === 'threads')
		return "the bot's threads could not be read again before this review was written."
	if (gap.kind === 'unread')
		return `the main reviewer answered without reading ${gap.unread} changed file(s).`
	return `only findings that do not block remain (${gap.findings}: unverified, below the severity floor, or nits), and the bot approves only a change it has nothing left to flag.`
}

/** Restrictions that stop an approval whatever the run covered, in the order the body names them. */
function toRestrictionTexts(evidence: ReviewedEvidence): readonly string[] {
	return [
		evidence.authored &&
			'the bot opened this pull request, and GitHub gives the author of a pull request no review state',
		evidence.open === false && 'the pull request is a draft, closed or merged',
		evidence.approval === 'preview' &&
			'approvals are turned off (`verdict.mode: preview`)',
		evidence.approval === 'token' &&
			'the job token cannot approve; only a GitHub App identity approves',
	].filter(text => text !== false)
}

/** The reasons as one sentence, each without its own closing period. */
function toSentence(reasons: readonly string[]): string {
	return reasons
		.map(reason => reason.replace(/\.$/u, ''))
		.join('; ')
		.concat('.')
}

/** Why the run did not approve, as one sentence; fixed text and counts, never model output. */
function toNotApprovedReason(evidence: ReviewEvidence): string {
	if (evidence.kind === 'offline')
		return 'the reviewer was offline, so this run judged nothing and kept the earlier state.'
	const off = evidence.kind === 'reply' ? !evidence.current : !evidence.onHead
	// A failed read keeps the state whatever the verdict, so it is the reason before any verdict.
	if (off && evidence.headUnknown)
		return 'the pull request could not be read again before the review, so the earlier state stands.'
	if (evidence.verdict === 'needs owner')
		return 'a thread waits for the owner to decide.'
	if (evidence.verdict === 'needs fixes')
		return `${evidence.openBugs} confirmed bug(s) at or above the severity floor are still open.`
	if (off)
		return 'the pull request moved to another commit, or could not be read again, while this run worked, so the earlier state stands.'
	if (!evidence.onHead)
		return 'replies were answered on a commit the last full review did not cover, so the earlier state stands.'
	if (evidence.kind === 'reply')
		return evidence.failed
			? 'a run of the last full review failed or did not report, so the earlier state stands.'
			: 'a run that only answers replies never approves; the next full review can.'
	if (!evidence.full)
		return 'this run reviewed with one agent only, so the earlier state stands.'
	const restrictions = toRestrictionTexts(evidence)
	if (evidence.gap)
		return toSentence([
			...[evidence.gap, ...(evidence.more ?? [])].map(toGapText),
			...restrictions,
		])
	if (evidence.verdict !== 'ready') return 'the review did not finish.'
	return toSentence(
		restrictions.length > 0
			? restrictions
			: ['the job token cannot approve; only a GitHub App identity approves']
	)
}

/**
 * The first line of the review body: the state in words that match it, and for anything but a
 * fresh approval one plain sentence on why the bot did not approve.
 */
export function formatReviewHeadline(input: HeadlineInput): string {
	const label = `**${STATE_LABEL[input.event]}.**`
	if (input.event !== 'APPROVE')
		return `${label} Not approved: ${toNotApprovedReason(input.evidence)}`
	if (!input.keep)
		return `${label} A full review of this commit read every changed file and kept no finding.`
	return `${label} An earlier full review of this commit approved it, and this run left that state: ${toNotApprovedReason(input.evidence)}`
}

/** The body without the headline an earlier write put first. */
export function toBodyWithoutHeadline(body: string): string {
	return body.replace(HEADLINE, '')
}

/** The body with `headline` first, replacing the one an earlier write put there. */
export function toBodyWithHeadline(body: string, headline: string): string {
	return `${headline}\n\n${toBodyWithoutHeadline(body)}`
}

/**
 * The decided summary whose body opens with the headline for `event`, the state it lands in: the
 * decided one for a new review, the edited review's own for an edit.
 */
export function toHeadedSummary(
	decided: DecidedSummary,
	event: ReviewEvent = decided.decision.event
): DecidedSummary {
	const headline = formatReviewHeadline({
		event,
		evidence: decided.rendered.evidence ?? { kind: 'offline', authored: false },
		keep: decided.decision.keep,
	})
	return {
		...decided,
		rendered: {
			...decided.rendered,
			body: toBodyWithHeadline(decided.rendered.body, headline),
		},
	}
}
