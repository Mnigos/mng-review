import { type Rules, RulesService } from '@mng-review/engine'
import {
	GitHubApiService,
	GitHubConfig,
	GitHubStatusService,
	provideOwnedIdentities,
	RiskSweepService,
	type SweepPullResult,
	toLogText,
} from '@mng-review/github'
import { Console, Effect } from 'effect'
import { getRiskGate } from '../../application/risk-gate.helper'
import { RiskRunService } from '../../application/risk-run.service'
import {
	failsThreadCheck,
	getSweepChecks,
} from '../../application/risk-sweep.helper'
import {
	dispatchWorkflowConfig,
	riskRunConfig,
	type RiskSweepTarget,
	riskSweepTargetConfig,
} from '../../infrastructure/risk-run.config'
import {
	runnerEnvironmentConfig,
	writeSummary,
} from '../../infrastructure/runner.client'
import {
	ActionExit,
	FAILED_EXIT_CODE,
	INVALID_CONFIG_EXIT_CODE,
} from '../action-exit.errors'
import { formatSweepSummary } from '../summary.formatter'

/** The rules the sweep reads: `HEAD` of the default branch checkout, never a pull request's. */
export const SWEEP_RULES_REF = 'HEAD'

/**
 * The risk gate every pull request into the default branch meets, and the review workflow the
 * sweep dispatches (`undefined` when unset: the thread raise still runs, and a dispatch the sweep
 * needs fails the job); `undefined` when the rules, the app or the settings do not rate.
 */
const readSweepGate = Effect.fn('riskSweepStep.readGate')(function* (
	rules: Rules
) {
	if (!rules.config.risk.enabled) return undefined
	const settings = yield* riskRunConfig
	const workflow = (yield* dispatchWorkflowConfig).trim()
	const { identity } = yield* GitHubConfig
	const gate = getRiskGate({
		config: rules.config,
		identity,
		settings,
		pr: { target: settings.defaultBranch },
	})
	if (gate.status !== 'on') return undefined
	return {
		gate,
		settings,
		...(workflow === '' ? {} : { workflow }),
	}
})

/**
 * The open pull requests the risk jobs of `status-sweep.yml` check, one matrix job each inside its
 * pull request's group; none when the rating is off, so the matrix job does not run. A list past
 * its page limit fails, since a pull request left out would get no thread raise.
 */
export const listRiskPulls = Effect.fn('riskSweepStep.listPulls')(function* (
	rules: Rules
) {
	if (!(yield* readSweepGate(rules))) return []
	const pulls = yield* (yield* GitHubStatusService).listOpenPullRequests({
		complete: true,
	})
	return pulls.map(pr => pr.number)
})

/** What one pull request's risk job did, and whether it must fail the job. */
interface RiskSweepReport {
	readonly lines: readonly string[]
	readonly failed: boolean
}

/** The line for the sweep's dispatch decision. */
function toResultLine(result: SweepPullResult): string {
	if (result.verdict === 'none') return 'nothing holds'
	if (result.verdict === 'no-workflow')
		return `${result.reason ?? ''}: a dispatch is needed but MNG_REVIEW_DISPATCH_WORKFLOW is not set`
	return `${result.reason ?? ''}: ${result.verdict}`
}

/**
 * The thread raise (a confirmed High or Critical bug raises the status to High in the write order)
 * and then one dispatch at most (an unrated head, an unanswered thread reply, a review not rated
 * since), for the one pull request the job was given. A thread raise that failed, could not read
 * the threads or may have left a grant fails the job after the dispatch check, and so does a
 * dispatch the sweep needed with no dispatch workflow set.
 */
const sweepOnePull = Effect.fn('riskSweepStep.sweepOnePull')(function* (
	rules: Rules,
	target: RiskSweepTarget
) {
	const sweep = yield* readSweepGate(rules)
	if (!sweep)
		return {
			lines: ['the risk rating is off'],
			failed: false,
		} satisfies RiskSweepReport
	const pr = yield* (yield* GitHubApiService).getPullRequest(target.pullNumber)
	if (pr.state !== 'open')
		return { lines: ['not open'], failed: false } satisfies RiskSweepReport
	const checks = getSweepChecks(pr, sweep.settings.defaultBranch, rules)
	// A fork, another base or a draft is not rated, so its threads raise nothing either.
	const raised = checks.converse
		? yield* (yield* RiskRunService).rateThread(sweep.gate, {
				pullNumber: pr.number,
				head: pr.head.sha,
				baseSha: pr.base.sha,
				defaultBranch: sweep.settings.defaultBranch,
				rules,
			})
		: undefined
	const result = yield* (yield* RiskSweepService).sweepPull({
		pullNumber: pr.number,
		head: pr.head.sha,
		...(pr.created_at ? { since: pr.created_at } : {}),
		repositoryId: target.repositoryId,
		checks,
		maxRuns: rules.config.limits.max_runs_per_pr,
		...(sweep.workflow === undefined ? {} : { workflow: sweep.workflow }),
		defaultBranch: sweep.settings.defaultBranch,
	})
	return {
		lines: [
			...(raised?.status === 'written' || raised?.status === 'failed'
				? [`thread check: ${raised.status}`]
				: []),
			toResultLine(result),
		],
		failed: failsThreadCheck(raised) || result.verdict === 'no-workflow',
	} satisfies RiskSweepReport
})

/** Writes the risk job's line to the log and the job summary. */
const finishRiskSweep = Effect.fn('riskSweepStep.finish')(function* (
	line: string
) {
	const env = yield* runnerEnvironmentConfig
	yield* Console.log(toLogText(`mng-review: ${line}`))
	yield* writeSummary(env.summaryPath, formatSweepSummary(line))
})

/**
 * The risk job of `status-sweep.yml` for the pull request in `MNG_REVIEW_TARGET_PR`, with the rules
 * of the default branch. Any failed read or write, a failed thread raise included, fails the job
 * with exit 1, so a pass that could not check never looks like one that found nothing.
 */
export const runRiskSweepStep = Effect.gen(function* () {
	const target = yield* riskSweepTargetConfig
	const prefix = `risk sweep #${target.pullNumber}`
	const report = yield* Effect.gen(function* () {
		const rules = yield* RulesService.use(service =>
			service.load(SWEEP_RULES_REF)
		)
		const { identity } = yield* GitHubConfig
		return yield* sweepOnePull(rules, target).pipe(
			provideOwnedIdentities(identity, rules.config.identity.previous)
		)
	}).pipe(
		Effect.catchTags({
			GitHubApiError: error =>
				Effect.succeed({ lines: [`failed: ${error.message}`], failed: true }),
			RiskStepOneError: error =>
				Effect.succeed({ lines: [`failed: ${error.message}`], failed: true }),
			GitError: error =>
				Effect.succeed({
					lines: [`failed: git: ${error.message}`],
					failed: true,
				}),
		})
	)
	const line = `${prefix}: ${report.lines.join('; ')}`
	if (!report.failed) return yield* finishRiskSweep(line)
	yield* finishRiskSweep(line)
	return yield* new ActionExit({ code: FAILED_EXIT_CODE })
})

/** A domain `ConfigError` or one of Effect's own config errors. */
interface ConfigFailure {
	readonly message: string
}

/** A broken setting or invalid rules: reported, and the job ends with exit 2 before any write. */
export const failRiskSweepConfig = Effect.fn('riskSweepStep.failConfig')(
	function* (error: ConfigFailure) {
		yield* finishRiskSweep(`risk sweep failed: ${error.message}`)
		return yield* new ActionExit({ code: INVALID_CONFIG_EXIT_CODE })
	}
)
