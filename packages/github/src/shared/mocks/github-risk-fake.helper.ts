import { Effect, Layer } from 'effect'
import type {
	RiskCommitStatus,
	TimelineItem,
	WorkflowJob,
	WorkflowRun,
} from '../../platform/github-risk.schema'
import {
	GitHubRiskService,
	type DispatchInput,
	type RunsQuery,
} from '../../platform/github-risk.service'
import type { GitHubApiError } from '../../platform/github.errors'

/** When a fixture run was created unless `created` says otherwise: after every fixture command. */
const RUN_CREATED = '2026-01-01T12:15:00Z'

/** True when GitHub would list the run for the query: each filter set must match. */
function isListed(run: WorkflowRun, query: RunsQuery): boolean {
	return (
		(query.status === undefined || run.status === query.status) &&
		(query.event === undefined || run.event === query.event) &&
		(query.branch === undefined || run.head_branch === query.branch) &&
		(query.workflow === undefined || run.path.endsWith(`/${query.workflow}`)) &&
		(query.since === undefined || run.created_at >= query.since)
	)
}

/** In-memory workflow, timeline and status reads with recorded dispatches and no HTTP client. */
export function githubRiskFake() {
	const statuses: RiskCommitStatus[] = []
	const timeline: TimelineItem[] = []
	const runs: WorkflowRun[] = []
	const jobs = new Map<number, WorkflowJob[]>()
	const dispatches: DispatchInput[] = []
	const queries: RunsQuery[] = []
	/** Failures the next run listings return, oldest first. */
	const runFailures: GitHubApiError[] = []
	/** Each run's creation time, or the error its read fails with. */
	const created = new Map<number, string | GitHubApiError>()
	const layer = Layer.succeed(GitHubRiskService, {
		listStatuses: () => Effect.succeed([...statuses]),
		createStatus: () =>
			Effect.die('unexpected status write in answer or dispatch test'),
		listTimeline: () => Effect.succeed([...timeline]),
		listRuns: query => {
			const failure = runFailures.shift()
			if (failure) return Effect.fail(failure)
			return Effect.sync(() => {
				queries.push(query)
				return runs.filter(run => isListed(run, query))
			})
		},
		listRunJobs: id => Effect.succeed(jobs.get(id) ?? []),
		dispatch: input =>
			Effect.sync(() => {
				dispatches.push(input)
			}),
		readCommentEdits: () => Effect.die('unexpected edit history read'),
		getRunCreated: runId => {
			const time = created.get(runId) ?? RUN_CREATED
			return typeof time === 'string' ? Effect.succeed(time) : Effect.fail(time)
		},
	})
	return {
		layer,
		statuses,
		timeline,
		runs,
		jobs,
		dispatches,
		queries,
		runFailures,
		created,
	}
}
