import type { ReviewReport } from '@mng-review/engine'
import { Context, Effect, Layer } from 'effect'
import { GitHubStatusService } from '../../../platform/github-status.service'
import { getAgentReport } from '../../publish/presentation/summary-agents.formatter'
import type { Verdict } from '../../publish/presentation/summary-comment.formatter'
import { toCommitStatus } from '../domain/status.helper'
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
}

/** What was written: check runs and whether the status was set. */
export interface StatusReportResult {
	readonly checks: number
	readonly status: boolean
}

/**
 * Writes one finished check run per agent that ran (`success` when it finished clean, `neutral`
 * otherwise, never blocking) and the `MNG Review` commit status from the verdict. A failed write
 * is counted out, never fatal.
 */
export class StatusReportService extends Context.Service<
	StatusReportService,
	{
		readonly report: (
			input: StatusReportInput
		) => Effect.Effect<StatusReportResult>
	}
>()('mng-review/StatusReportService') {}

export const StatusReportServiceLive = Layer.effect(
	StatusReportService,
	Effect.gen(function* () {
		const github = yield* GitHubStatusService

		const report = Effect.fn('StatusReportService.report')(function* (
			input: StatusReportInput
		) {
			const { plan } = input.report.planReport
			const runs = plan.runs.filter(
				(run, index, all) =>
					all.findIndex(other => other.name === run.name) === index
			)
			const checks = yield* Effect.forEach(
				runs,
				run => {
					const agent = getAgentReport(run, input.report.agents)
					const findings = [...input.report.bugs, ...input.report.nits].filter(
						finding => finding.agents.includes(run.name)
					)
					const clean = agent?.status === 'ok' && findings.length === 0
					return github
						.createCheckRun({
							headSha: input.head,
							name: toCheckName(run.name),
							conclusion: clean ? 'success' : 'neutral',
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
			const status = yield* github
				.setStatus({
					sha: input.head,
					...toCommitStatus(input.verdict, input.openBugs),
				})
				.pipe(
					Effect.as(true),
					Effect.orElseSucceed(() => false)
				)
			return {
				checks: checks.reduce((sum, written) => sum + written, 0),
				status,
			}
		})

		return { report }
	})
)
