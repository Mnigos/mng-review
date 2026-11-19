import { REDACTED, toReviewJson } from '@mng-review/engine'
import { Predicate } from 'effect'
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
	/** The endpoint's masked values, replaced in every string of the file. */
	readonly masked: readonly string[]
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

/** The text with every masked value replaced, longest first so a value that holds another goes whole. */
function toRedacted(text: string, masked: readonly string[]): string {
	return masked
		.toSorted((a, b) => b.length - a.length)
		.reduce((out, value) => out.replaceAll(value, REDACTED), text)
}

/** Maps keyed by names from the configuration (model names), whose keys are data, not schema. */
const DATA_KEYED_MAPS = new Set(['tokens', 'tokenSources'])

/**
 * A JSON value with the masked values replaced in strings and in the keys of the maps keyed by
 * model names. Schema keys, numbers, booleans and arrays pass through; `JSON.stringify` visits
 * the members.
 */
function toRedactedValue(
	key: string,
	value: unknown,
	masked: readonly string[]
): unknown {
	if (Predicate.isString(value)) return toRedacted(value, masked)
	if (!DATA_KEYED_MAPS.has(key) || !Predicate.isObject(value)) return value
	return Object.fromEntries(
		Object.entries(value).map(([name, member]) => [
			toRedacted(name, masked),
			member,
		])
	)
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
			...toOutcomeJson(outcome),
		},
		(key, value: unknown) => toRedactedValue(key, value, masked),
		2
	)
}
