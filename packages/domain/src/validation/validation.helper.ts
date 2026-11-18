import type { ModelSetting, ReviewConfig } from '../config/review-config.schema'
import {
	type AgentsByName,
	getSeverityFloor,
	placeNits,
} from '../findings/finding-placement.helper'
import { isAtLeast, sortFindings } from '../findings/finding.helper'
import type { Finding } from '../findings/finding.types'
import type {
	KeptFinding,
	RejectedFinding,
	ReviewOutcome,
	Validation,
} from './validation.types'

/** The finding inputs of an outcome, bugs and validations index by index. */
export interface OutcomeInput {
	readonly bugs: readonly Finding[]
	readonly validations: readonly Validation[]
	readonly nits: readonly Finding[]
	readonly config: ReviewConfig
	readonly agents: AgentsByName
}

const NOT_VALIDATED = {
	status: 'unvalidated',
	error: 'not validated',
} as const satisfies Validation

/**
 * Validator models for a finding, best first. `cross` prefers reviewer models that did not report
 * it, a declared agent's model included, then the ones that did, in a fresh conversation. An explicit
 * validator comes first, then the reviewer models in case it is dropped.
 */
export function getValidatorChoices(
	finding: Pick<Finding, 'models'>,
	config: ReviewConfig
): ModelSetting[] {
	const { validator, reviewer } = config.models
	if (validator !== 'cross')
		return [
			validator,
			...reviewer.filter(entry => entry.model !== validator.model),
		]
	const reported = (entry: ModelSetting) => finding.models.includes(entry.model)
	return [
		...reviewer.filter(entry => !reported(entry)),
		...reviewer.filter(reported),
	]
}

/** True when the validator answered `unverified`. */
function isUnverified(finding: KeptFinding): boolean {
	return finding.validation?.status === 'unverified'
}

/**
 * Applies the validator's answers, then `comments.min_severity` to bugs (the lowest floor among a
 * finding's agents) and `comments.max_nits` to nits. A rejected bug leaves the list; an unvalidated
 * one stays at its reported severity. An unverified bug (it rests on a dependency's behaviour) stays
 * at the validator's severity, goes to the summary so it never blocks, and comes after the others.
 */
export function decideOutcome(input: OutcomeInput): ReviewOutcome {
	const { config, agents } = input
	const kept: KeptFinding[] = []
	const rejected: RejectedFinding[] = []
	for (const [index, finding] of input.bugs.entries()) {
		const validation = input.validations[index] ?? NOT_VALIDATED
		if (validation.status === 'rejected') {
			rejected.push({
				...finding,
				reason: validation.reason,
				evidence: validation.evidence,
				validatedBy: validation.model,
			})
			continue
		}
		const severity =
			validation.status === 'unvalidated'
				? finding.severity
				: validation.severity
		const floor = getSeverityFloor(finding, config, agents)
		const inline =
			validation.status !== 'unverified' && isAtLeast(severity, floor)
		kept.push({
			...finding,
			...(severity === finding.severity
				? {}
				: { reportedSeverity: finding.severity }),
			severity,
			validation,
			placement: inline ? 'inline' : 'summary',
		})
	}
	return {
		bugs: [
			...sortFindings(kept.filter(finding => !isUnverified(finding))),
			...sortFindings(kept.filter(isUnverified)),
		],
		nits: placeNits(input.nits, config, agents),
		rejected: sortFindings(rejected),
	}
}
