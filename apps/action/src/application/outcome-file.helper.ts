import type { ThreadRecheckProposals } from '@mng-review/github'
import {
	type OutcomeBinding,
	type OutcomeFile,
	OUTCOME_VERSION,
} from '../infrastructure/outcome-file.schema'
import type { RunnerEnvironment } from '../infrastructure/runner.client'
import { toRedactedValue } from '../utils/redact.util'
import type { PullRequestEvent, ShadowOutcome } from './shadow-run.types'

/** The runner's variables an outcome is bound to. */
export type BindingEnvironment = Pick<
	RunnerEnvironment,
	'repository' | 'runId' | 'runAttempt' | 'engineCommit'
>

/** The binding's fields in the order a mismatch is reported. */
const BINDING_FIELDS = [
	'repository',
	'runId',
	'runAttempt',
	'engineCommit',
	'pullNumber',
	'baseSha',
	'headSha',
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
 * The outcome file of a run: its binding, status, reason, the review report and the threads the
 * re-check proposes to resolve. An outcome without an event (an invalid event, not a pull
 * request) has nothing to publish and gives no file.
 */
export function toOutcomeFile(
	outcome: ShadowOutcome,
	recheck: ThreadRecheckProposals | undefined,
	env: BindingEnvironment
): OutcomeFile | undefined {
	if (!outcome.event) return undefined
	const tokens = recheck?.tokens
	return {
		version: OUTCOME_VERSION,
		binding: toOutcomeBinding(outcome.event, env),
		status: outcome.status,
		...toOutcomeReason(outcome),
		...(outcome.status === 'reviewed' ? { report: outcome.report } : {}),
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
	}
}

/**
 * The outcome file as JSON, with the endpoint's masked values replaced in every string and in the
 * model names that key the token maps, as in the result file.
 */
export function toOutcomeText(
	file: OutcomeFile,
	masked: readonly string[]
): string {
	const values = masked.filter(value => value.length > 0)
	return JSON.stringify(file, (key, value: unknown) =>
		toRedactedValue(key, value, values)
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
