import type { Severity } from '../config/review-config.schema'
import { getSeverityRank } from '../findings/finding.helper'
import { normalizeRepoPath } from '../utils/repo-path.util'
import type { Judgement, Unverified } from './validation.types'
import type { Verdict } from './verdict.schema'

/** The path of a `path:line` evidence entry; the path may hold spaces, not colons. */
const EVIDENCE_PATH = /^([^\s:](?:[^:]*[^\s:])?):\d+/u
/** `premise` of a rejection kept as unverified when the validator named none. */
export const UNNAMED_PREMISE = 'not named by the validator'

/** What `toValidation` reads besides the answer. */
export interface VerdictInput {
	readonly verdict: Verdict
	/** The finder's severity. */
	readonly reported: Severity
	readonly model: string
	/** At least one evidence entry names a file of this repository. */
	readonly hasRepositoryEvidence: boolean
}

/**
 * The repository paths that evidence entries name, normalised and without repeats; entries that do
 * not start with `path:line` or leave the repository are skipped.
 */
export function getEvidencePaths(evidence: readonly string[]): string[] {
	const paths = evidence.flatMap(entry => {
		const path = EVIDENCE_PATH.exec(entry.trim())?.[1]
		const normalized = path === undefined ? undefined : normalizeRepoPath(path)
		return normalized === undefined || normalized === '.' ? [] : [normalized]
	})
	return [...new Set(paths)]
}

/**
 * Turns a validator's answer into a validation, enforcing two rules the prompt states. A severity
 * below the reported one stands only with `lowered_because`; otherwise the reported severity is kept.
 * A rejection must cite a file of this repository; otherwise the finding is kept as unverified at
 * the reported severity, because a refutation the repository does not show may rest on the
 * validator's memory of a dependency. Each change is recorded in `note`.
 */
export function toValidation(input: VerdictInput): Judgement | Unverified {
	const { verdict, reported, model } = input
	const loweredBecause = verdict.lowered_because || undefined
	const lowered = getSeverityRank(verdict.severity) < getSeverityRank(reported)
	const unexplained = lowered && !loweredBecause
	const base = {
		reason: verdict.reason,
		evidence: verdict.evidence,
		model,
	}
	if (verdict.verdict === 'reject' && !input.hasRepositoryEvidence)
		return {
			...base,
			status: 'unverified',
			severity: reported,
			premise: verdict.premise || UNNAMED_PREMISE,
			note: 'rejected without citing lines of this repository, so kept as unverified',
		}
	const severityFields = unexplained
		? {
				severity: reported,
				note: `kept the reported ${reported}: the validator lowered it to ${verdict.severity} without naming the criterion that fails`,
			}
		: {
				severity: verdict.severity,
				...(lowered && loweredBecause ? { loweredBecause } : {}),
			}
	if (verdict.verdict === 'unverified')
		return {
			...base,
			...severityFields,
			status: 'unverified',
			premise: verdict.premise || UNNAMED_PREMISE,
		}
	return {
		...base,
		...severityFields,
		status: verdict.verdict === 'confirm' ? 'confirmed' : 'rejected',
	}
}
