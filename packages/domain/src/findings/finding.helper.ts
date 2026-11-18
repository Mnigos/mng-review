import { createHash } from 'node:crypto'
import { SEVERITIES } from '../config/review-config.constants'
import type { Severity } from '../config/review-config.schema'
import {
	FINGERPRINT_LENGTH,
	NEAR_LINES,
	SAME_DESCRIPTION_OVERLAP,
	SAME_TITLE_OVERLAP,
	STOP_WORDS,
} from './finding.constants'
import type { ReportedFinding } from './finding.schema'
import type { Finding, FindingReporter } from './finding.types'

/** Code punctuation the title words drop, `-` and `/` included. */
const TITLE_PUNCTUATION = /[`'"()[\]{}<>.,:;!?/-]/gu

/** Position in `SEVERITIES`; higher is more severe. */
export function getSeverityRank(severity: Severity): number {
	return SEVERITIES.indexOf(severity)
}

/** True when the severity is at or above the floor. */
export function isAtLeast(severity: Severity, floor: Severity): boolean {
	return getSeverityRank(severity) >= getSeverityRank(floor)
}

/** Lowercase content words of a title, without numbers, stop words and code punctuation. */
export function getTitleWords(title: string): string[] {
	return title
		.toLowerCase()
		.replace(TITLE_PUNCTUATION, ' ')
		.split(/\s+/u)
		.filter(word => word && !STOP_WORDS.has(word) && !/^\d+$/u.test(word))
}

/**
 * A short hash of the path and the title's sorted, distinct content words. It survives line
 * shifts, case, punctuation, numbers and word order, so a later run recognises its own finding.
 */
export function toFingerprint(
	finding: Pick<Finding, 'path' | 'title'>
): string {
	const words = [...new Set(getTitleWords(finding.title))].toSorted().join(' ')
	return createHash('sha256')
		.update(`${finding.path}\n${words}`)
		.digest('hex')
		.slice(0, FINGERPRINT_LENGTH)
}

/** A reported finding attributed to the agent and model that reported it. */
export function toFinding(
	reported: ReportedFinding,
	reporter: FindingReporter
): Finding {
	const { suggestion, ...rest } = reported
	return {
		...rest,
		...(suggestion ? { suggestion } : {}),
		kind: reporter.kind,
		agents: [reporter.agent],
		models: [reporter.model],
		fingerprint: toFingerprint(reported),
	}
}

/** A word without a plural `s`, so `urls` and `url` count as one word. */
function toWordStem(word: string): string {
	return word.length > 3 && word.endsWith('s') && !word.endsWith('ss')
		? word.slice(0, -1)
		: word
}

/** Distinct stemmed content words of a finding's title, trigger and impact. */
function getDescriptionWords(
	finding: Pick<Finding, 'title' | 'trigger' | 'impact'>
): Set<string> {
	const text = `${finding.title} ${finding.trigger} ${finding.impact}`
	return new Set(getTitleWords(text).map(toWordStem))
}

/** Shared words over the smaller set's size; 0 when either set is empty. */
function getOverlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	const smaller = Math.min(a.size, b.size)
	if (smaller === 0) return 0
	return [...a].filter(word => b.has(word)).length / smaller
}

/** True when no agent and model pair reported both; one finder never reports a problem twice. */
function hasOtherReporter(a: Finding, b: Finding): boolean {
	const sameAgent = a.agents.some(agent => b.agents.includes(agent))
	const sameModel = a.models.some(model => b.models.includes(model))
	return !(sameAgent && sameModel)
}

/**
 * Same root cause: same kind and file, and the same fingerprint, or lines at most `NEAR_LINES`
 * apart with title word overlap (Jaccard) of at least `SAME_TITLE_OVERLAP`. Nearby reports from
 * different finders also merge when their descriptions share `SAME_DESCRIPTION_OVERLAP` of the
 * shorter one's words, since two finders word one defect differently. The same line alone is not
 * enough, and a bug never merges with a nit.
 */
export function isSameRootCause(a: Finding, b: Finding): boolean {
	if (a.kind !== b.kind || a.path !== b.path) return false
	if (a.fingerprint === b.fingerprint) return true
	if (Math.abs(a.line - b.line) > NEAR_LINES) return false
	const wordsA = new Set(getTitleWords(a.title))
	const wordsB = new Set(getTitleWords(b.title))
	const union = new Set([...wordsA, ...wordsB]).size
	const shared = [...wordsA].filter(word => wordsB.has(word)).length
	if (union > 0 && shared / union >= SAME_TITLE_OVERLAP) return true
	return (
		hasOtherReporter(a, b) &&
		getOverlap(getDescriptionWords(a), getDescriptionWords(b)) >=
			SAME_DESCRIPTION_OVERLAP
	)
}

/** The kept finding with the other's agents, models and evidence added. */
function absorb(kept: Finding, other: Finding): Finding {
	const suggestion = kept.suggestion ?? other.suggestion
	return {
		...kept,
		agents: [...new Set([...kept.agents, ...other.agents])],
		models: [...new Set([...kept.models, ...other.models])],
		evidence: [...new Set([...kept.evidence, ...other.evidence])],
		...(suggestion ? { suggestion } : {}),
	}
}

/**
 * Merges findings with the same root cause. The merged finding keeps the text and the severity of
 * the most severe report and every agent, model and distinct evidence line. Inputs are not modified.
 */
export function mergeFindings(findings: readonly Finding[]): Finding[] {
	const merged: Finding[] = []
	/** Every report absorbed into each merged finding, so later reports match any of them. */
	const members: Finding[][] = []
	const bySeverity = findings.toSorted(
		(a, b) => getSeverityRank(b.severity) - getSeverityRank(a.severity)
	)
	for (const finding of bySeverity) {
		const index = members.findIndex(group =>
			group.some(member => isSameRootCause(member, finding))
		)
		const match = merged[index]
		if (match) {
			merged[index] = absorb(match, finding)
			members[index]?.push(finding)
			continue
		}
		merged.push(finding)
		members.push([finding])
	}
	return merged
}

/** Most severe first, then by path and line. The input is not modified. */
export function sortFindings<TFinding extends Finding>(
	findings: readonly TFinding[]
): TFinding[] {
	return findings.toSorted(
		(a, b) =>
			getSeverityRank(b.severity) - getSeverityRank(a.severity) ||
			a.path.localeCompare(b.path) ||
			a.line - b.line
	)
}
