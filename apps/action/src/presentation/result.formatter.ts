import { toReviewJson } from '@mng-review/engine'
import type {
	PullRequestEvent,
	ShadowOutcome,
} from '../application/shadow-run.types'
import { toVerdictLine } from './summary.formatter'

/** Bumped when a field of the result file changes meaning or goes away. */
export const RESULT_VERSION = 1

/** What the result file says about the run besides the outcome. */
export interface ResultContext {
	readonly engineCommit: string | undefined
	readonly repository: string | undefined
	readonly eventName: string
	readonly runId: string | undefined
	readonly runAttempt: string | undefined
	/** From the start of the entry to the outcome, endpoint probe and rules included. */
	readonly wallMillis: number
}

/** The pull request's number, commits and the metadata the plan used; no title or body. */
function toPullRequestJson(event: PullRequestEvent | undefined) {
	if (!event) return null
	return {
		number: event.number,
		baseSha: event.baseSha,
		headSha: event.headSha,
		target: event.pr.target ?? null,
		author: event.pr.author ?? null,
		labels: event.pr.labels,
		draft: event.pr.draft,
	}
}

/** The outcome's reason, the file or key of an invalid configuration, and the verdict. */
function toOutcomeJson(outcome: ShadowOutcome) {
	if (outcome.status === 'reviewed')
		return {
			reason: null,
			source: null,
			verdict: toVerdictLine(outcome.report),
			tokens: outcome.report.tokens,
			review: toReviewJson(outcome.report),
		}
	return {
		reason: outcome.reason,
		source: outcome.status === 'invalid-config' ? outcome.source : null,
		verdict: null,
		tokens: {},
		review: null,
	}
}

/**
 * The result file the workflow uploads as an artifact, so real runs can be analysed through the
 * API: the status, the run and pull request, wall time, tokens per model and, for a reviewed run,
 * the document `mng-review --json` prints. It carries no secret; the writer also redacts the
 * endpoint's masked values.
 */
export function formatResult(
	outcome: ShadowOutcome,
	context: ResultContext
): string {
	const event = 'event' in outcome ? outcome.event : undefined
	return JSON.stringify(
		{
			version: RESULT_VERSION,
			status: outcome.status,
			engineCommit: context.engineCommit ?? null,
			run: {
				repository: context.repository ?? null,
				eventName: context.eventName,
				runId: context.runId ?? null,
				runAttempt: context.runAttempt ?? null,
			},
			pullRequest: toPullRequestJson(event),
			wallMillis: context.wallMillis,
			...toOutcomeJson(outcome),
		},
		null,
		2
	)
}
