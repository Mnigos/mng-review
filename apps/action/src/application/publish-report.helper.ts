import type { ConfigError } from '@mng-review/domain'
import type { GitError } from '@mng-review/engine'
import { GitHubApiError, PublishIncompleteError } from '@mng-review/github'
import type {
	OutcomeFile,
	OutcomeReplies,
} from '../infrastructure/outcome-file.schema'
import type { RiskRunSettings } from '../infrastructure/risk-run.config'
import type { PublishContext, PublishReport } from './publish-run.service'
import type { RiskGate } from './risk-gate.helper'
import type { RiskReport } from './risk-run.service'

/** No environment and no default branch: the rating refuses. */
const NO_RISK_SETTINGS = {
	environment: '',
	defaultBranch: '',
} as const satisfies RiskRunSettings

/** The rating's settings from the job, or none, which the gate refuses. */
export function toRiskSettings(context: PublishContext): RiskRunSettings {
	return context.risk ?? NO_RISK_SETTINGS
}

/** The report's `risk` field; absent while `risk.enabled` is off, so nothing changes then. */
export function toRiskField(risk: RiskReport): { readonly risk?: RiskReport } {
	return risk.status === 'off' ? {} : { risk }
}

/** A failed publish; while the rating is on it carries a failed rating, which fails the job. */
export function toFailed(reason: string, gate: RiskGate): PublishReport {
	return {
		status: 'failed',
		reason,
		...(gate.status === 'on' ? { risk: { status: 'failed', reason } } : {}),
	}
}

/**
 * True when the report fails the job: a failed rating, a grant that may still stand because its
 * revocation was refused, which the cleanup step then writes again, or an answer left unsettled
 * (its thread could not be reopened after it), so the run hold applies.
 */
export function failsRating(report: PublishReport): boolean {
	if (
		(report.status === 'published' || report.status === 'replied') &&
		report.result.unsettled > 0
	)
		return true
	const risk = 'risk' in report ? report.risk : undefined
	if (risk?.status === 'failed') return true
	return risk?.status === 'written' && risk.result.grantStands === true
}

/** The `MNG Review` status GitHub refused while the run rates: the publish fails on it. */
export function toStatusWriteError(): PublishIncompleteError {
	return new PublishIncompleteError({
		error: new GitHubApiError({
			operation: 'status',
			reason: 'the MNG Review status could not be written',
		}),
	})
}

/** Why the rules at the base commit did not load. */
export function toRulesReason(error: ConfigError | GitError): string {
	return error._tag === 'ConfigError'
		? `the rules at the base commit: ${error.source}: ${error.reason}`
		: `the rules at the base commit: git: ${error.message}`
}

/** A reply schedule run's decisions, or `undefined` for any other run. */
export function getConverseReplies(
	outcome: OutcomeFile,
	context: PublishContext
): OutcomeReplies | undefined {
	return context.converse && outcome.status === 'replied'
		? outcome.replies
		: undefined
}

/** True when the file has nothing this job publishes: only a reviewed, offline or replied run has. */
export function isUnpublished(
	outcome: OutcomeFile,
	context: PublishContext
): boolean {
	if (context.converse || outcome.status === 'replied')
		return getConverseReplies(outcome, context) === undefined
	return outcome.status !== 'reviewed' && outcome.status !== 'offline'
}
