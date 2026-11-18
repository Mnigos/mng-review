import { createHash } from 'node:crypto'
import { SEVERITIES } from '../config/review-config.constants'
import type { Severity } from '../config/review-config.schema'
import {
	FINGERPRINT_LENGTH,
	NEAR_LINES,
	SAME_DESCRIPTION_OVERLAP,
	SAME_FAILURE_OVERLAP,
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

/** Distinct stemmed content words of the given texts. */
function getStemmedWords(...texts: readonly string[]): Set<string> {
	return new Set(getTitleWords(texts.join(' ')).map(toWordStem))
}

/** Shared words over the smaller set's size; 0 when either set is empty. */
function getOverlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	const smaller = Math.min(a.size, b.size)
	if (smaller === 0) return 0
	return [...a].filter(word => b.has(word)).length / smaller
}

/**
 * Shared content words (stemmed, without stop words) of two texts over the shorter one's; 0 when
 * either has none.
 */
export function getWordOverlap(left: string, right: string): number {
	return getOverlap(getStemmedWords(left), getStemmedWords(right))
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
 * shorter one's words and their titles and impacts `SAME_FAILURE_OVERLAP`, since two finders word
 * one defect differently. The same line alone is not
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
	if (!hasOtherReporter(a, b)) return false
	const description = getOverlap(
		getStemmedWords(a.title, a.trigger, a.impact),
		getStemmedWords(b.title, b.trigger, b.impact)
	)
	const failure = getOverlap(
		getStemmedWords(a.title, a.impact),
		getStemmedWords(b.title, b.impact)
	)
	return (
		description >= SAME_DESCRIPTION_OVERLAP && failure >= SAME_FAILURE_OVERLAP
	)
}

/** The kept finding with the other's agents, models and evidence added. */
export function absorb(kept: Finding, other: Finding): Finding {
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
 * A report joins a group when it has the same root cause as one member and no member from its own
 * finder (agent and model) reports something else, so a chain of loose matches never folds one
 * finder's two distinct problems into one.
 */
function canJoin(group: readonly Finding[], finding: Finding): boolean {
	const matches = group.map(member => isSameRootCause(member, finding))
	if (!matches.includes(true)) return false
	return group.every(
		(member, index) => matches[index] || hasOtherReporter(member, finding)
	)
}

/** The reports, most severe first. */
function toBySeverity(findings: readonly Finding[]): Finding[] {
	return findings.toSorted(
		(a, b) => getSeverityRank(b.severity) - getSeverityRank(a.severity)
	)
}

/**
 * Adds one report to the groups: a new group when it joins none, every group it joins when they
 * can be one group, else the first group it joins.
 */
function addToGroups(groups: Finding[][], finding: Finding): Finding[][] {
	const joined = groups.filter(group => canJoin(group, finding))
	const [first] = joined
	if (!first) return [...groups, [finding]]
	const combined = [...joined.flat(), finding]
	if (isConsistentGroup(combined))
		return [...groups.filter(group => !joined.includes(group)), combined]
	return groups.map(group => (group === first ? [...group, finding] : group))
}

/** True when no two reports of one finder in the group are left without a match between them. */
function isConsistentGroup(group: readonly Finding[]): boolean {
	return group.every((member, index) =>
		group
			.slice(index + 1)
			.every(
				other =>
					hasOtherReporter(member, other) || isSameRootCause(member, other)
			)
	)
}

/**
 * Merges findings with the same root cause. The merged finding keeps the text and the severity of
 * the most severe report and every agent, model and distinct evidence line. A report that matches
 * several groups joins them all when no finder would end up with two distinct reports in one group,
 * so the result does not depend on the order of the reports. The result is most severe first, the
 * order validation spends its tokens in. Inputs are not modified.
 */
export function mergeFindings(findings: readonly Finding[]): Finding[] {
	const groups = toBySeverity(findings).reduce<Finding[][]>(addToGroups, [])
	return toBySeverity(
		groups.map(group =>
			toBySeverity(group).reduce((kept, other) => absorb(kept, other))
		)
	)
}

/**
 * Two merged bugs that may be one defect worded differently, for the validator to judge: same kind
 * and path, lines at most `NEAR_LINES` apart, and no finder (agent and model) reported both, so one
 * finder's own distinct reports are never offered as duplicates.
 */
export function isNearDuplicate(a: Finding, b: Finding): boolean {
	return (
		a.kind === b.kind &&
		a.path === b.path &&
		Math.abs(a.line - b.line) <= NEAR_LINES &&
		hasOtherReporter(a, b)
	)
}

/**
 * The findings in groups linked by `isNearDuplicate`, each group and the groups in input order; a
 * finding with no near duplicate is a group of one.
 */
export function getNearGroups(findings: readonly Finding[]): Finding[][] {
	const groups: Finding[][] = []
	for (const finding of findings) {
		const [first, ...others] = groups.filter(group =>
			group.some(member => isNearDuplicate(member, finding))
		)
		if (!first) {
			groups.push([finding])
			continue
		}
		first.push(...others.flat(), finding)
		for (const other of others) groups.splice(groups.indexOf(other), 1)
	}
	return groups.map(group =>
		group.toSorted((a, b) => findings.indexOf(a) - findings.indexOf(b))
	)
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
