import { Effect } from 'effect'
import { ConfigError } from '../config/config.errors'
import type { BenchFile, ExpectedFinding } from './bench-file.schema'
import type {
	BenchFinding,
	BenchMatch,
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
 * on the same path within `lineWindow` lines.
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
	return {
		found: matches.filter(match => match.expected.label === 'real'),
		missed: input.expected.filter(
			(entry, index) => entry.label === 'real' && !pairs.has(index)
		),
		noise: matches.filter(match => match.expected.label !== 'real'),
		unmatched: input.findings.filter((_, index) => !matchedFindings.has(index)),
	}
}

/** Totals over the cases of a run, with recall over `real` entries and unmatched findings per case. */
export function toBenchTotals(cases: readonly CaseCounts[]): BenchTotals {
	const sum = (count: (entry: CaseCounts) => number) =>
		cases.reduce((total, entry) => total + count(entry), 0)
	const found = sum(entry => entry.score.found.length)
	const missed = sum(entry => entry.score.missed.length)
	const unmatched = sum(entry => entry.score.unmatched.length)
	return {
		cases: cases.length,
		found,
		missed,
		noise: sum(entry => entry.score.noise.length),
		unmatched,
		nits: sum(entry => entry.nits),
		recall: found + missed === 0 ? null : found / (found + missed),
		unmatchedPerCase: cases.length === 0 ? null : unmatched / cases.length,
	}
}
