import { toReviewJson } from '@mng-review/engine'
import type { PublishReport } from '../application/publish-run.service'
import type {
	PullRequestEvent,
	ShadowOutcome,
} from '../application/shadow-run.types'
import { toRedactedValue } from '../utils/redact.util'
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
	/** From the start of the entry to the outcome, endpoint probe, rules and publishing included. */
	readonly wallMillis: number
	/** The endpoint's masked values, replaced in every string of the file. */
	readonly masked: readonly string[]
	/** Set in publish mode: what was posted. */
	readonly publish?: PublishReport
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
 * the document `mng-review --json` prints. Every string in it has the endpoint's masked values
 * replaced, in values and in the model names that key the token maps; numbers and other values
 * stay as they are.
 */
export function formatResult(
	outcome: ShadowOutcome,
	context: ResultContext
): string {
	const event = 'event' in outcome ? outcome.event : undefined
	const masked = context.masked.filter(value => value.length > 0)
	return JSON.stringify(
		{
			version: RESULT_VERSION,
			status: outcome.status,
			engineCommit: context.engineCommit ?? null,
			run: {
				repository: context.repository ?? null,
				eventName: context.eventName || null,
				runId: context.runId ?? null,
				runAttempt: context.runAttempt ?? null,
			},
			pullRequest: toPullRequestJson(event),
			wallMillis: context.wallMillis,
			mode: context.publish ? 'publish' : 'shadow',
			publish: context.publish ?? null,
			...toOutcomeJson(outcome),
		},
		(key, value: unknown) => toRedactedValue(key, value, masked),
		2
	)
}
