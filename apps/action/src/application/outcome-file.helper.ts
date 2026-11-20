import {
	MAX_REPORT_ENTRIES,
	MAX_REPORT_NAME,
	MAX_REPORT_NAMES,
	MAX_REPORT_TEXT,
	type ThreadRecheckProposals,
} from '@mng-review/github'
import { Predicate } from 'effect'
import type { RunTrigger } from '../infrastructure/command-run.config'
import {
	type OutcomeBinding,
	type OutcomeFile,
	type OutcomeReplies,
	OUTCOME_VERSION,
} from '../infrastructure/outcome-file.schema'
import type { RunnerEnvironment } from '../infrastructure/runner.client'
import { toRedacted, toRedactedValue } from '../utils/redact.util'
import type {
	PullRequestEvent,
	ReviewedRun,
	ShadowOutcome,
} from './shadow-run.types'

/** The runner's variables an outcome is bound to, and the trigger, `push` when unset. */
export interface BindingEnvironment extends Pick<
	RunnerEnvironment,
	'repository' | 'runId' | 'runAttempt' | 'engineCommit'
> {
	readonly trigger?: RunTrigger
}

/** The binding's fields in the order a mismatch is reported. */
const BINDING_FIELDS = [
	'repository',
	'runId',
	'runAttempt',
	'engineCommit',
	'pullNumber',
	'baseSha',
	'headSha',
	'trigger',
] as const satisfies readonly (keyof OutcomeBinding)[]

/**
 * The run and pull request an outcome belongs to, from the runner's variables and the event. An
 * unset variable is empty, so a file written outside a workflow binds to no workflow run.
 */
export function toOutcomeBinding(
	event: PullRequestEvent,
	env: BindingEnvironment
): OutcomeBinding {
	return {
		repository: env.repository ?? '',
		runId: env.runId ?? '',
		runAttempt: env.runAttempt ?? '',
		engineCommit: env.engineCommit || null,
		pullNumber: event.number,
		baseSha: event.baseSha,
		headSha: event.headSha,
		trigger: env.trigger ?? 'push',
	}
}

/** The report publishing needs: without the plan's file list, which only the review reads. */
function toPublishedReport(
	report: ReviewedRun['report']
): ReviewedRun['report'] {
	const { planReport } = report
	return {
		...report,
		planReport: { ...planReport, plan: { ...planReport.plan, files: [] } },
	}
}

/** The outcome's reason and, for an invalid configuration, the file or key it names. */
function toOutcomeReason(outcome: ShadowOutcome) {
	if (outcome.status === 'reviewed') return {}
	if (outcome.status === 'invalid-config')
		return { reason: outcome.reason, source: outcome.source }
	return { reason: outcome.reason }
}

/**
 * The outcome file of a run: its binding, status, reason, the review report, the threads the
 * re-check proposes to resolve and the decisions on authors' replies. An outcome without an event
 * (an invalid event, not a pull request) has nothing to publish and gives no file.
 */
export function toOutcomeFile(
	outcome: ShadowOutcome,
	recheck: ThreadRecheckProposals | undefined,
	env: BindingEnvironment,
	replies?: OutcomeReplies
): OutcomeFile | undefined {
	if (!outcome.event) return undefined
	const tokens = recheck?.tokens
	return {
		version: OUTCOME_VERSION,
		binding: toOutcomeBinding(outcome.event, env),
		status: outcome.status,
		...toOutcomeReason(outcome),
		...(outcome.status === 'reviewed'
			? { report: toPublishedReport(outcome.report) }
			: {}),
		...(recheck && tokens
			? {
					recheck: {
						checked: recheck.checked,
						rejected: recheck.rejected.map(entry => ({
							threadId: entry.thread.id,
							fingerprint: entry.thread.marker.fingerprint,
							reason: entry.reason,
						})),
						tokens,
					},
				}
			: {}),
		...(replies ? { replies } : {}),
	}
}

/** Keys of model and error text, cut to `MAX_REPORT_TEXT`; their values may carry the endpoint. */
const TEXT_KEYS = new Set([
	'title',
	'trigger',
	'impact',
	'suggestion',
	'reason',
	'error',
	'endpointError',
	'detail',
	'premise',
	'note',
	'loweredBecause',
	'memory',
])
/** Keys of model names, cut to `MAX_REPORT_NAME`. */
const NAME_KEYS = new Set(['model', 'fellBackFrom', 'validatedBy'])
/** Keys of text lists and name lists, each entry cut and the list capped. */
const TEXT_LIST_KEYS = new Set(['evidence'])
const NAME_LIST_KEYS = new Set(['models'])

/** The text with the masked values replaced, then cut to `max` characters. */
function toBoundedText(
	text: string,
	masked: readonly string[],
	max: number
): string {
	return toRedacted(text, masked).slice(0, max)
}

/** How long each entry of a bounded list may be and how many entries it keeps. */
interface ListBounds {
	readonly chars: number
	readonly entries: number
}

/** A list of texts redacted and cut to its bounds. */
function toBoundedList(
	value: unknown,
	masked: readonly string[],
	bounds: ListBounds
): unknown {
	if (!Array.isArray(value)) return value
	const entries: readonly unknown[] = value
	return entries
		.slice(0, bounds.entries)
		.map(entry =>
			Predicate.isString(entry)
				? toBoundedText(entry, masked, bounds.chars)
				: entry
		)
}

/**
 * One JSON value of the outcome file: model and error text redacted and cut to the schema's
 * bounds, the model names that key the token maps redacted. Protocol values, the binding, paths
 * and fingerprints pass unchanged, so a masked value that is a common word cannot break them.
 */
function toOutcomeValue(
	key: string,
	value: unknown,
	masked: readonly string[]
): unknown {
	if (Predicate.isString(value)) {
		if (TEXT_KEYS.has(key)) return toBoundedText(value, masked, MAX_REPORT_TEXT)
		if (NAME_KEYS.has(key)) return toBoundedText(value, masked, MAX_REPORT_NAME)
		return value
	}
	if (TEXT_LIST_KEYS.has(key))
		return toBoundedList(value, masked, {
			chars: MAX_REPORT_TEXT,
			entries: MAX_REPORT_ENTRIES,
		})
	if (NAME_LIST_KEYS.has(key))
		return toBoundedList(value, masked, {
			chars: MAX_REPORT_NAME,
			entries: MAX_REPORT_NAMES,
		})
	return toRedactedValue(key, value, masked)
}

/**
 * The outcome file as JSON. Model and error text is redacted and cut to the schema's bounds, so
 * one long or unlucky field never stops the whole run from publishing; see `toOutcomeValue`.
 */
export function toOutcomeText(
	file: OutcomeFile,
	masked: readonly string[]
): string {
	const values = masked.filter(value => value.length > 0)
	return JSON.stringify(file, (key, value: unknown) =>
		toOutcomeValue(key, value, values)
	)
}

/**
 * The first binding field where the file differs from what the runner and the event say, or
 * `undefined` when it belongs to this run. `trusted` never comes from the file.
 */
export function getBindingMismatch(
	binding: OutcomeBinding,
	trusted: OutcomeBinding
): keyof OutcomeBinding | undefined {
	return BINDING_FIELDS.find(field => binding[field] !== trusted[field])
}

/**
 * True when the publish job has something to post: a reviewed run whose plan did not skip it, or
 * an offline endpoint on a push run. An offline command posts nothing. Every other outcome posts
 * nothing, so the publish job does not start.
 */
export function isPublishable(
	outcome: ShadowOutcome,
	trigger: RunTrigger = 'push'
): boolean {
	if (outcome.status === 'offline') return trigger === 'push'
	return (
		outcome.status === 'reviewed' && !outcome.report.planReport.plan.skippedRun
	)
}

/** Why a binding field that differs stops publishing; a re-run of the publish job alone changes the attempt. */
export function toMismatchReason(field: keyof OutcomeBinding): string {
	const reason = `the outcome file belongs to another run: ${field} differs`
	return field === 'runAttempt'
		? `${reason}; re-run all jobs, not the publish job alone`
		: reason
}
