import type { Plan } from '../routing/review-plan.types'

/** Characters of the last reviewed commit named in a skip reason. */
const SHORT_SHA_LENGTH = 8

/**
 * The plan for a run after an earlier one: every run with `input: incremental` keeps only the files
 * changed since the last reviewed commit, and one with none left is skipped with that commit named.
 * `full_diff` and `metadata` runs keep their files, so they still see the whole change.
 */
export function toIncrementalPlan(
	plan: Plan,
	changedSince: ReadonlySet<string>,
	since: string
): Plan {
	const narrowed = plan.runs.map(run =>
		run.input === 'incremental'
			? { ...run, files: run.files.filter(path => changedSince.has(path)) }
			: run
	)
	const reason = `no change since the last review at ${since.slice(0, SHORT_SHA_LENGTH)}`
	return {
		...plan,
		runs: narrowed.filter(
			run => run.input !== 'incremental' || run.files.length > 0
		),
		skips: [
			...plan.skips,
			...narrowed
				.filter(run => run.input === 'incremental' && run.files.length === 0)
				.filter(
					(run, index, all) =>
						all.findIndex(other => other.name === run.name) === index
				)
				.map(run => ({ name: run.name, title: run.title, reason })),
		],
	}
}
