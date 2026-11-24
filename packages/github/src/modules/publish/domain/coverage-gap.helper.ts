import { getFingerprints } from '@mng-review/domain'
import type { ReviewReport } from '@mng-review/engine'
import type { BotThread } from './publish.types'

/**
 * Why a run is no evidence that the whole change was reviewed with nothing left to say, with the
 * counts the review body names: no main reviewer ran (a quick review skips it); changed files were
 * skipped as too large or binary; the token budget stopped a finder or a validation; a run failed
 * or never reported; the main reviewer answered with changed files unread (a file its first message
 * cut short counts until it reads it); findings that never block remain; or publishing could not
 * read the bot's threads again before the write (`threads`), so a thread reopened meanwhile could
 * go unseen.
 */
export type CoverageGap =
	| { readonly kind: 'no-reviewer' }
	| {
			readonly kind: 'skipped'
			readonly tooLarge: number
			readonly binary: number
			readonly files: number
	  }
	| { readonly kind: 'budget' }
	| { readonly kind: 'failed'; readonly failed: number; readonly runs: number }
	| { readonly kind: 'unread'; readonly unread: number }
	| { readonly kind: 'findings'; readonly findings: number }
	| { readonly kind: 'threads' }

/** A planned run or an agent report, matched by name. */
type NamedRun = Pick<ReviewReport['agents'][number], 'name'>

/** A thread of the bot as the coverage check reads it. */
type CoverageThread = Pick<BotThread, 'resolved' | 'marker'>

/** How many of `entries` carry `name`. */
function countNamed(name: string, entries: readonly NamedRun[]): number {
	return entries.filter(entry => entry.name === name).length
}

/**
 * Planned runs without a report of their own, and reports that failed or lost a unit. Runs share a
 * name (one main reviewer run per model at deep depth), so each name needs a report per run.
 */
function countFailedRuns(report: ReviewReport): number {
	const { runs } = report.planReport.plan
	const missing = [...new Set(runs.map(run => run.name))].reduce(
		(sum, name) =>
			sum +
			Math.max(0, countNamed(name, runs) - countNamed(name, report.agents)),
		0
	)
	const failed = report.agents.filter(
		agent =>
			agent.status === 'failed' ||
			agent.error !== undefined ||
			agent.endpointError === true
	).length
	return missing + failed
}

/**
 * True when a planned run never reported, a run or one of its units failed (an agent `error`, such
 * as a deep unit's `LoopError` beside units that answered), or the endpoint failed. Such a run
 * clears no change request; nits, unverified findings and skipped files are a different gap.
 */
export function hasFailedRuns(report: ReviewReport): boolean {
	return countFailedRuns(report) > 0 || report.endpointError !== undefined
}

/** True when the token budget stopped a finder, a unit or a validation. */
function isBudgetStopped(report: ReviewReport): boolean {
	return (
		report.incomplete !== undefined ||
		report.agents.some(
			agent =>
				agent.status === 'incomplete' || (agent.unfinished?.length ?? 0) > 0
		)
	)
}

/**
 * Every reason the run does not cover the change, in this order, or none when it does: the main
 * reviewer ran, no changed file was skipped as too large or binary (`skip.paths` is the rules'
 * choice), the budget stopped nothing, every planned run reported `ok` with no failed unit, the
 * main reviewer read every changed file, the run kept no finding (unverified, below the floor or
 * nit), and `threads`, publishing's own read of the bot's threads, holds no open unverified or nit
 * thread. The findings count adds the open threads no kept finding matches by one of its
 * fingerprints (`getFingerprints`); the unread count is the most any one run left unread. A report
 * with an endpoint error counts as failed.
 */
export function getCoverageGaps(
	report: ReviewReport,
	threads: readonly CoverageThread[]
): readonly CoverageGap[] {
	const { plan, change } = report.planReport
	// The plan and the change each list the files; a skip in either leaves the file unread.
	const skips = new Map(
		[...change.files, ...plan.files].flatMap(file =>
			file.skipped === 'too_large' || file.skipped === 'binary'
				? [[file.path, file.skipped] as const]
				: []
		)
	)
	const tooLarge = [...skips.values()].filter(
		skip => skip === 'too_large'
	).length
	const binary = skips.size - tooLarge
	const failed = countFailedRuns(report)
	// Reports carry counts, not paths, and runs of one name may leave the same file unread, so the
	// most any one run left unread is the count of distinct files that is known.
	const unread = Math.max(0, ...report.agents.map(agent => agent.unread ?? 0))
	const kept = [...report.bugs, ...report.nits]
	const fingerprints = new Set(
		kept.flatMap(finding => getFingerprints(finding))
	)
	// A thread the run's own finding matches counts once, as that finding.
	const open = threads.filter(
		thread =>
			!thread.resolved &&
			thread.marker.kind !== 'bug' &&
			!fingerprints.has(thread.marker.fingerprint)
	).length
	const findings = kept.length + open
	const gaps: (CoverageGap | false)[] = [
		!plan.runs.some(run => run.role === 'reviewer') && { kind: 'no-reviewer' },
		tooLarge + binary > 0 && {
			kind: 'skipped',
			tooLarge,
			binary,
			files: change.files.length,
		},
		isBudgetStopped(report) && { kind: 'budget' },
		hasFailedRuns(report) && {
			kind: 'failed',
			failed: Math.max(1, failed),
			runs: plan.runs.length,
		},
		unread > 0 && { kind: 'unread', unread },
		findings > 0 && { kind: 'findings', findings },
	]
	return gaps.filter(gap => gap !== false)
}

/** The first of `getCoverageGaps`, or `undefined` when the run covers the change. */
export function getCoverageGap(
	report: ReviewReport,
	threads: readonly CoverageThread[]
): CoverageGap | undefined {
	return getCoverageGaps(report, threads)[0]
}
