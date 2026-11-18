import type { BenchFinding, BenchMatch } from '@mng-review/domain'
import type { BenchReport, CaseReport } from '@mng-review/engine'
import { toModelTokenLines, toSourceTokenLines } from './tokens.formatter'

const MILLIS_PER_SECOND = 1000
const PERCENT = 100

/** Seconds with one decimal. */
function toSeconds(millis: number): string {
	return `${(millis / MILLIS_PER_SECOND).toFixed(1)} s`
}

/** A finding as `path:line severity status title`. */
function toFindingText(finding: BenchFinding): string {
	return `${finding.path}:${finding.line} ${finding.severity} ${finding.status} ${finding.title}`
}

/** A matched entry with the finding that matched it. */
function toMatchLine(kind: string, match: BenchMatch): string {
	return `    ${kind}  ${match.expected.id} (${match.expected.label})  ${toFindingText(match.finding)}`
}

/** The counts of one case, then each match, miss, noise and unmatched finding, then its tokens. */
function toCaseLines(entry: CaseReport): string[] {
	const { score } = entry
	const real = score.found.length + score.missed.length + score.near.length
	const header = `${entry.id}  ${entry.depth.level}  real ${score.found.length}/${real} found, ${score.near.length} near, ${score.missed.length} missed, noise ${score.noise.length}, unmatched ${score.unmatched.length}, rejected ${entry.rejected.length}, nits ${entry.nits}, ${toSeconds(entry.wallMillis)}`
	return [
		header,
		...(entry.skipped ? [`    skipped  ${entry.skipped}`] : []),
		...(entry.endpointError
			? [`    endpoint error  ${entry.endpointError}`]
			: []),
		...(entry.incomplete
			? [`    incomplete  token budget spent: ${entry.incomplete.join('; ')}`]
			: []),
		...score.found.map(match => toMatchLine('found', match)),
		...score.missed.map(
			expected =>
				`    missed  ${expected.id}  ${expected.path}:${expected.line}  ${expected.summary}`
		),
		...score.near.map(match => toMatchLine('near', match)),
		...score.noise.map(match => toMatchLine('noise', match)),
		...score.unmatched.map(
			finding => `    unmatched  ${toFindingText(finding)}`
		),
		...entry.rejected.map(
			finding =>
				`    rejected  ${finding.path}:${finding.line} ${finding.severity} ${finding.title} (${finding.validatedBy}: ${finding.reason})`
		),
		`    depth  ${entry.depth.level} (${entry.depth.source}), risk ${entry.risk}`,
		...toModelTokenLines(entry.tokens, '    tokens  '),
		...toSourceTokenLines(entry.tokenSources, '    source  '),
	]
}

/** Recall as a percentage with the counts behind it. */
function toRecallText({ totals }: BenchReport): string {
	const real = totals.found + totals.missed + totals.near
	if (totals.recall === null) return 'n/a (no real entries)'
	return `${(totals.recall * PERCENT).toFixed(1)}% (${totals.found} of ${real} real)`
}

/** Every case, then the totals, recall, unmatched findings per case and tokens per model. */
export function formatBenchText(report: BenchReport): string {
	const { totals } = report
	return [
		`Benchmark ${report.file}, rules: ${report.rulesSource}, line window ${report.lineWindow}`,
		'',
		...report.cases.flatMap(toCaseLines),
		'',
		`Totals (${totals.cases} case(s)): real found ${totals.found} (${totals.confirmed} confirmed, ${totals.unverified} unverified), near ${totals.near}, missed ${totals.missed}, noise ${totals.noise}, unmatched ${totals.unmatched}, nits ${totals.nits}`,
		`Recall: ${toRecallText(report)}`,
		`Unmatched per case: ${totals.unmatchedPerCase === null ? 'n/a' : totals.unmatchedPerCase.toFixed(2)}`,
		...(Object.keys(report.tokens).length === 0
			? []
			: ['Tokens:', ...toModelTokenLines(report.tokens, '  ')]),
		`Wall time: ${toSeconds(report.wallMillis)}`,
	].join('\n')
}

/** The report as a JSON document. */
export function formatBenchJson(report: BenchReport): string {
	return JSON.stringify(report, null, 2)
}
