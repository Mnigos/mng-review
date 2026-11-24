import type {
	WorkflowJob,
	WorkflowRun,
} from '../../../platform/github-risk.schema'
import type { EntryQualifier } from './reply-answer.helper'
import {
	DISPATCH_EVENT,
	RATING_CONCLUSIONS,
	RISK_JOB_NAMES,
	SKIPPED_CONCLUSION,
} from './risk.constants'
import {
	type DispatchKey,
	isJobNamed,
	parseDecideJobName,
} from './sweep-dispatch.helper'

/** A run of the review workflow for the pull request, with what its fixed jobs say. */
export interface SweptRun {
	readonly run: WorkflowRun
	/** The key its decide job's name carries; only a dispatched run has one. */
	readonly key?: DispatchKey
	/** How the rating job ended; `null` while it runs, `skipped` when it did not run. */
	readonly rating: string | null
	/** How the job that entered the group ended: the converse job for a converse, else the rating job. */
	readonly group: string | null
	/** How the decide job ended; `undefined` for a run without one. */
	readonly decide?: string | null
}

/**
 * How the job with the fixed name ended. A job still running has no conclusion yet; a completed
 * run without the job, which never entered the group, counts as `skipped`.
 */
function getJobConclusion(
	run: WorkflowRun,
	jobs: readonly WorkflowJob[],
	name: string
): string | null {
	const job = jobs.find(found => isJobNamed(found.name, name))
	if (job?.status === 'completed' && job.conclusion !== null)
		return job.conclusion
	return run.status === 'completed' ? SKIPPED_CONCLUSION : null
}

/** Reads a run's decide key and how its decide job ended, and its rating and converse jobs by name. */
export function toSweptRun(
	run: WorkflowRun,
	jobs: readonly WorkflowJob[]
): SweptRun {
	const decideJob = jobs.find(job => parseDecideJobName(job.name) !== undefined)
	const key = decideJob && parseDecideJobName(decideJob.name)
	const rating = getJobConclusion(run, jobs, RISK_JOB_NAMES.RATING)
	const converse = getJobConclusion(run, jobs, RISK_JOB_NAMES.CONVERSE)
	const isConverse =
		key?.kind === 'converse' ||
		(key === undefined && rating === SKIPPED_CONCLUSION)
	return {
		run,
		...(key ? { key } : {}),
		...(decideJob
			? {
					decide:
						decideJob.status === 'completed' ? decideJob.conclusion : null,
				}
			: {}),
		rating,
		group: isConverse ? converse : rating,
	}
}

/**
 * True for a full rating: a push run, a `review` command or a dispatched `review`, whose rating job
 * concluded `success` or `failure`. A converse, reply-only, `run <agent>` or refused run never
 * counts, and neither does a dispatch whose decide job names no key.
 */
export function isFullRating(swept: SweptRun): boolean {
	const kind =
		swept.key?.kind ??
		(swept.run.event === DISPATCH_EVENT ? undefined : 'review')
	return (
		kind === 'review' &&
		RATING_CONCLUSIONS.some(conclusion => conclusion === swept.rating)
	)
}

/**
 * An answer created before the reply's current edit time names it only through its `run`: one of
 * the pull request's runs of the review workflow, created after that time, whose group job did not
 * conclude `skipped`.
 */
export function toEntryQualifier(runs: readonly SweptRun[]): EntryQualifier {
	return (entry, version) =>
		runs.some(
			swept =>
				swept.run.id === entry.run &&
				swept.run.created_at > version.at &&
				swept.group !== SKIPPED_CONCLUSION
		)
}
