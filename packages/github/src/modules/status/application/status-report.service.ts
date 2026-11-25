import type { ReviewReport } from '@mng-review/engine'
import { Context, Effect, Layer } from 'effect'
import { GitHubStatusService } from '../../../platform/github-status.service'
import {
	getIncompleteLists,
	isReadIncomplete,
} from '../../../platform/list-completeness.context'
import type { OwnedIdentities } from '../../../platform/owned-identities.context'
import { getAgentReport } from '../../publish/presentation/summary-agents.formatter'
import type { Verdict } from '../../publish/presentation/summary-comment.formatter'
import {
	type CommitStatusText,
	toCommitStatus,
	toIncompleteStatus,
	UNFINISHED_NOTE,
} from '../domain/status.helper'
import {
	formatCheckSummary,
	formatCheckTitle,
	toCheckName,
} from '../presentation/check-run.formatter'

/** One run's outcome on its head commit. */
export interface StatusReportInput {
	readonly head: string
	readonly report: ReviewReport
	readonly verdict: Verdict
	readonly openBugs: number
	/** A full review finished on this head; a partial run alone never makes it so. */
	readonly finished: boolean
}

/** What was written: check runs and whether the status was set. */
export interface StatusReportResult {
	readonly checks: number
	readonly status: boolean
}

/**
 * Writes one finished check run per agent that ran (`success` when every run of it finished clean,
 * `neutral` otherwise, never blocking) and the `MNG Review` commit status from the verdict, or
 * `error` when the reviewer was offline or publishing failed part way. A failed write is counted
 * out, never fatal. Once a list read of the run left a node out (`isReadIncomplete`), no check
 * run and no status is `success` (`toIncompleteStatus`).
 */
export class StatusReportService extends Context.Service<
	StatusReportService,
	{
		readonly report: (
			input: StatusReportInput
		) => Effect.Effect<StatusReportResult, never, OwnedIdentities>
		/**
		 * Sets the `MNG Review` status a verdict gives; while the run is incomplete, never `success`
		 * (`toIncompleteStatus`), which reads the head's status first. `false` when the write, or
		 * that read, failed; a status that blocks or did not finish is written without the read.
		 */
		readonly setVerdictStatus: (
			head: string,
			next: CommitStatusText
		) => Effect.Effect<boolean, never, OwnedIdentities>
		/** Sets `error` on a head the review could not run on; `false` when the write failed. */
		readonly reportOffline: (head: string) => Effect.Effect<boolean>
		/**
		 * Sets `error` on a head whose publish failed after it may have posted threads, so an earlier
		 * `success` does not stay; `false` when the write failed.
		 */
		readonly reportUnfinished: (head: string) => Effect.Effect<boolean>
	}
>()('mng-review/StatusReportService') {}

export const StatusReportServiceLive = Layer.effect(
	StatusReportService,
	Effect.gen(function* () {
		const github = yield* GitHubStatusService

		const setVerdictStatus = Effect.fn('StatusReportService.setVerdictStatus')(
			function* (head: string, next: CommitStatusText) {
				const lists = yield* getIncompleteLists
				// A thread the run could not see may block, so the head's own status decides a success.
				const text =
					lists.length > 0 && next.state === 'success'
						? toIncompleteStatus(next, yield* github.getStatus(head), lists)
						: next
				if (!text) return true
				yield* github.setStatus({ sha: head, ...text })
				return true
			},
			Effect.orElseSucceed(() => false)
		)

		const report = Effect.fn('StatusReportService.report')(function* (
			input: StatusReportInput
		) {
			const incomplete = yield* isReadIncomplete
			const { plan } = input.report.planReport
			const runs = plan.runs.filter(
				(run, index, all) =>
					all.findIndex(other => other.name === run.name) === index
			)
			const checks = yield* Effect.forEach(
				runs,
				run => {
					const agent = getAgentReport(run, input.report.agents)
					const reports = input.report.agents.filter(
						entry => entry.name === run.name
					)
					const findings = [...input.report.bugs, ...input.report.nits].filter(
						finding => finding.agents.includes(run.name)
					)
					const clean =
						reports.length > 0 &&
						reports.every(entry => entry.status === 'ok') &&
						findings.length === 0
					return github
						.createCheckRun({
							headSha: input.head,
							name: toCheckName(run.name),
							conclusion: clean && !incomplete ? 'success' : 'neutral',
							title: formatCheckTitle(agent, findings),
							summary: formatCheckSummary(findings),
						})
						.pipe(
							Effect.as(1),
							Effect.orElseSucceed(() => 0)
						)
				},
				{ concurrency: 1 }
			)
			const status = yield* setVerdictStatus(
				input.head,
				toCommitStatus(input.verdict, input.openBugs, input.finished)
			)
			return {
				checks: checks.reduce((sum, written) => sum + written, 0),
				status,
			}
		})

		/** Sets `error` with `description`; a failed write is `false`, never fatal. */
		const setError = (head: string, description: string) =>
			github.setStatus({ sha: head, state: 'error', description }).pipe(
				Effect.as(true),
				Effect.orElseSucceed(() => false)
			)

		const reportOffline = Effect.fn('StatusReportService.reportOffline')(
			function* (head: string) {
				return yield* setError(
					head,
					`the reviewer was offline; ${UNFINISHED_NOTE}`
				)
			}
		)

		const reportUnfinished = Effect.fn('StatusReportService.reportUnfinished')(
			function* (head: string) {
				return yield* setError(head, `publishing failed; ${UNFINISHED_NOTE}`)
			}
		)

		return { report, setVerdictStatus, reportOffline, reportUnfinished }
	})
)
