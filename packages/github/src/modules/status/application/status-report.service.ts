import type { ReviewReport } from '@mng-review/engine'
import { Context, Effect, Layer, Result } from 'effect'
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
	toIncompleteMarkerStatus,
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
	/** The run's summary marker keeps the hold an incomplete write left (`PublishResult.held`). */
	readonly held?: true
}

/** What was written: check runs and whether the status was set. */
export interface StatusReportResult {
	readonly checks: number
	readonly status: boolean
	/** An incomplete run could not read the head's status for a held `success`, so it wrote none. */
	readonly statusUnread?: true
}

/** What a verdict's status write did. */
export interface VerdictStatusWrite {
	/** The status was set, or the head keeps the one it has. */
	readonly set: boolean
	/**
	 * An incomplete run could not read the head's status for a would-be `success`, so it wrote
	 * none: `pending` written blind could lower a `failure`.
	 */
	readonly unread?: true
}

/**
 * Writes one finished check run per agent that ran (`success` when every run of it finished clean,
 * `neutral` otherwise, never blocking) and the `MNG Review` commit status from the verdict, or
 * `error` when the reviewer was offline or publishing failed part way. A failed write is counted
 * out, never fatal. Once a list read of the run left a node out (`isReadIncomplete`), no check
 * run and no status is `success` (`toIncompleteStatus`). While the run's summary marker keeps the
 * hold an incomplete write left (`held`), a status that does not block lowers no `failure`
 * (`setIncompleteMarkerStatus`).
 */
export class StatusReportService extends Context.Service<
	StatusReportService,
	{
		readonly report: (
			input: StatusReportInput
		) => Effect.Effect<StatusReportResult, never, OwnedIdentities>
		/**
		 * Sets the `MNG Review` status a verdict gives; while the run is incomplete, never `success`
		 * (`toIncompleteStatus`), which reads the head's status first. Not `set` when the write, or
		 * that read, failed; a failed read is `unread` and logged as a warning. A status that blocks
		 * or did not finish is written without the read.
		 */
		readonly setVerdictStatus: (
			head: string,
			next: CommitStatusText
		) => Effect.Effect<VerdictStatusWrite, never, OwnedIdentities>
		/**
		 * Sets the status a standing judged from a summary marker an incomplete write left gives
		 * (`toIncompleteMarkerStatus`): a `failure` always, anything else only over no status or a
		 * `success`, through `setVerdictStatus`. When the head's status cannot be read it writes
		 * nothing, since that status may be a `failure`; the result is `unread` and logged.
		 */
		readonly setIncompleteMarkerStatus: (
			head: string,
			next: CommitStatusText
		) => Effect.Effect<VerdictStatusWrite, never, OwnedIdentities>
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

		/** Writes `text` on `head`; a failed write is not `set`. */
		const writeStatus = (head: string, text: CommitStatusText) =>
			github.setStatus({ sha: head, ...text }).pipe(
				Effect.as<VerdictStatusWrite>({ set: true }),
				Effect.orElseSucceed((): VerdictStatusWrite => ({ set: false }))
			)

		const setVerdictStatus = Effect.fn('StatusReportService.setVerdictStatus')(
			function* (head: string, next: CommitStatusText) {
				const lists = yield* getIncompleteLists
				if (lists.length === 0 || next.state !== 'success')
					return yield* writeStatus(head, next)
				// A thread the run could not see may block, so the head's own status decides a success.
				const previous = yield* Effect.result(github.getStatus(head))
				if (Result.isFailure(previous)) {
					yield* Effect.logWarning(
						`mng-review: the MNG Review status of ${head} could not be read after a list read left an entry out (${lists.join(', ')}), so this run wrote no status`
					)
					return { set: false, unread: true } satisfies VerdictStatusWrite
				}
				const text = toIncompleteStatus(next, previous.success)
				if (!text) return { set: true } satisfies VerdictStatusWrite
				return yield* writeStatus(head, text)
			}
		)

		const setIncompleteMarkerStatus = Effect.fn(
			'StatusReportService.setIncompleteMarkerStatus'
		)(function* (head: string, next: CommitStatusText) {
			if (next.state === 'failure') return yield* setVerdictStatus(head, next)
			const previous = yield* Effect.result(github.getStatus(head))
			if (Result.isFailure(previous)) {
				yield* Effect.logWarning(
					`mng-review: the MNG Review status of ${head} could not be read under an unfinished summary, so this run wrote no status`
				)
				return { set: false, unread: true } satisfies VerdictStatusWrite
			}
			const text = toIncompleteMarkerStatus(next, previous.success)
			if (!text) return { set: true } satisfies VerdictStatusWrite
			return yield* setVerdictStatus(head, text)
		})

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
			const setStatus = input.held
				? setIncompleteMarkerStatus
				: setVerdictStatus
			const status = yield* setStatus(
				input.head,
				toCommitStatus(input.verdict, input.openBugs, input.finished)
			)
			return {
				checks: checks.reduce((sum, written) => sum + written, 0),
				status: status.set,
				...(status.unread ? { statusUnread: true } : {}),
			} satisfies StatusReportResult
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

		return {
			report,
			setVerdictStatus,
			setIncompleteMarkerStatus,
			reportOffline,
			reportUnfinished,
		}
	})
)
