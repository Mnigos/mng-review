import { Effect } from 'effect'
import { ConfigError } from '../config/config.errors'
import { SAME_DESCRIPTION_OVERLAP } from '../findings/finding.constants'
import { getWordOverlap } from '../findings/finding.helper'
import type { KeptFinding } from '../validation/validation.types'
import type { BenchFile, ExpectedFinding } from './bench-file.schema'
import type {
	BenchFinding,
	BenchMatch,
	BenchStatus,
	BenchTotals,
	CaseCounts,
	CaseScore,
} from './bench.types'

/** One possible match: indexes into the entries and the findings, and their line distance. */
interface Candidate {
	readonly entry: number
	readonly finding: number
	readonly distance: number
}

/** What the matching of one case compares. */
export interface MatchInput {
	readonly expected: readonly ExpectedFinding[]
	readonly findings: readonly BenchFinding[]
	readonly lineWindow: number
}

/** A kept bug as the benchmark reports it; a bug without a validation counts as unvalidated. */
export function toBenchFinding(finding: KeptFinding): BenchFinding {
	const status = finding.validation?.status
	return {
		path: finding.path,
		line: finding.line,
		title: finding.title,
		severity: finding.severity,
		trigger: finding.trigger,
		impact: finding.impact,
		status:
			status === undefined || status === 'rejected' ? 'unvalidated' : status,
	}
}

/** The directory of a repository path; `''` at the root. */
function getDirectory(path: string): string {
	return path.slice(0, Math.max(0, path.lastIndexOf('/')))
}

/**
 * True when the finding sits in a sibling file of the entry (another file of the same directory)
 * and describes the same defect: its title, trigger and impact share at least
 * `SAME_DESCRIPTION_OVERLAP` of the entry summary's content words, the share at which two reports
 * count as one problem when merging.
 */
function isNearMatch(entry: ExpectedFinding, finding: BenchFinding): boolean {
	return (
		finding.path !== entry.path &&
		getDirectory(finding.path) === getDirectory(entry.path) &&
		getWordOverlap(
			entry.summary,
			[finding.title, finding.trigger, finding.impact].join(' ')
		) >= SAME_DESCRIPTION_OVERLAP
	)
}

/**
 * Pairs each `real` entry left unmatched with the first unmatched finding near it (`isNearMatch`),
 * each finding at most once, entries in file order.
 */
function getNearMatches(
	missed: readonly ExpectedFinding[],
	unmatched: readonly BenchFinding[]
): BenchMatch[] {
	const used = new Set<BenchFinding>()
	return missed.flatMap(expected => {
		const finding = unmatched.find(
			candidate => !used.has(candidate) && isNearMatch(expected, candidate)
		)
		if (!finding) return []
		used.add(finding)
		return [{ expected, finding }]
	})
}

/** The cases `ids` names, in file order, or every case when `ids` is empty. An unknown id fails. */
export function getBenchCases(
	file: BenchFile,
	ids: readonly string[],
	source: string
): Effect.Effect<BenchFile['cases'], ConfigError> {
	if (ids.length === 0) return Effect.succeed(file.cases)
	const unknown = ids.filter(id => !file.cases.some(entry => entry.id === id))
	if (unknown.length > 0)
		return Effect.fail(
			new ConfigError({
				source,
				reason: `no case with id ${unknown.map(id => JSON.stringify(id)).join(', ')}`,
			})
		)
	return Effect.succeed(file.cases.filter(entry => ids.includes(entry.id)))
}

/** Every entry and finding on the same path within the line window, closest first. */
function getCandidates(input: MatchInput): Candidate[] {
	return input.expected
		.flatMap((entry, entryIndex) =>
			input.findings.map((finding, findingIndex) => ({
				entry: entryIndex,
				finding: findingIndex,
				distance:
					finding.path === entry.path
						? Math.abs(finding.line - entry.line)
						: Number.POSITIVE_INFINITY,
			}))
		)
		.filter(candidate => candidate.distance <= input.lineWindow)
		.toSorted(
			(left, right) =>
				left.distance - right.distance ||
				left.entry - right.entry ||
				left.finding - right.finding
		)
}

/**
 * Pairs entries with findings, closest lines first, so each entry matches at most one finding and
 * each finding at most one entry. Ties go to the earlier entry, then the earlier finding.
 */
function toPairs(input: MatchInput): ReadonlyMap<number, number> {
	const pairs = new Map<number, number>()
	const usedFindings = new Set<number>()
	for (const candidate of getCandidates(input)) {
		if (pairs.has(candidate.entry) || usedFindings.has(candidate.finding))
			continue
		pairs.set(candidate.entry, candidate.finding)
		usedFindings.add(candidate.finding)
	}
	return pairs
}

/**
 * Compares the bug findings of one case with its expected entries. A finding matches an entry
 * on the same path within `lineWindow` lines. A `real` entry left unmatched with a finding near it
 * (`isNearMatch`) is a near match: neither found nor missed, and its finding is not unmatched.
 */
export function toCaseScore(input: MatchInput): CaseScore {
	const pairs = toPairs(input)
	const matches = input.expected.flatMap((expected, index) => {
		const findingIndex = pairs.get(index)
		const finding =
			findingIndex === undefined ? undefined : input.findings[findingIndex]
		return finding ? [{ expected, finding } satisfies BenchMatch] : []
	})
	const matchedFindings = new Set(pairs.values())
	const missed = input.expected.filter(
		(entry, index) => entry.label === 'real' && !pairs.has(index)
	)
	const unmatched = input.findings.filter(
		(_, index) => !matchedFindings.has(index)
	)
	const near = getNearMatches(missed, unmatched)
	return {
		found: matches.filter(match => match.expected.label === 'real'),
		missed: missed.filter(
			entry => !near.some(match => match.expected === entry)
		),
		near,
		noise: matches.filter(match => match.expected.label !== 'real'),
		unmatched: unmatched.filter(
			finding => !near.some(match => match.finding === finding)
		),
	}
}

/** Totals over the cases of a run, with recall over `real` entries and unmatched findings per case. */
export function toBenchTotals(cases: readonly CaseCounts[]): BenchTotals {
	const sum = (count: (entry: CaseCounts) => number) =>
		cases.reduce((total, entry) => total + count(entry), 0)
	const found = sum(entry => entry.score.found.length)
	const missed = sum(entry => entry.score.missed.length)
	const near = sum(entry => entry.score.near.length)
	const unmatched = sum(entry => entry.score.unmatched.length)
	const real = found + missed + near
	const withStatus = (status: BenchStatus) =>
		sum(
			entry =>
				entry.score.found.filter(match => match.finding.status === status)
					.length
		)
	return {
		cases: cases.length,
		found,
		confirmed: withStatus('confirmed'),
		unverified: withStatus('unverified'),
		missed,
		near,
		noise: sum(entry => entry.score.noise.length),
		unmatched,
		nits: sum(entry => entry.nits),
		recall: real === 0 ? null : found / real,
		unmatchedPerCase: cases.length === 0 ? null : unmatched / cases.length,
	}
}
