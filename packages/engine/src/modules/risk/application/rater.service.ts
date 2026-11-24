import {
	type Change,
	getFloorReport,
	type ModelSetting,
	type Plan,
	type PullRequestInfo,
	type ReviewOutcome,
	type StatusLevel,
	toCutLine,
	toRulesDigest,
} from '@mng-review/domain'
import { Context, Effect, Layer, Result } from 'effect'
import type { Rules } from '../../../platform/config/rules.service'
import { GitService } from '../../../platform/git/git.service'
import { toCauseMessage } from '../../converse/domain/reply-attempt.helper'
import type { LoopCoverage } from '../../review/application/agent-loop.types'
import { getChangedLines } from '../../review/application/read-coverage.helper'
import { RATER_REPO_TOOLS } from '../../review/application/repo.toolkit'
import { ReportRiskTool } from '../../review/application/report-risk.tool'
import { AgentLoopService } from '../../review/application/services/agent-loop.service'
import { ModelHealthService } from '../../review/application/services/model-health.service'
import type { RepoScope } from '../../review/application/services/repo-tools.service'
import { getWholePaths } from '../../review/domain/finder-message.helper'
import { MAX_FULL_DIFF_CHARS } from '../../review/domain/review.constants'
import { LoopError } from '../../review/domain/review.errors'
import { toRaterMessage } from '../domain/rater-message.helper'
import {
	MAX_RISK_DETAIL_CHARS,
	NO_RATER_MODEL,
	RATER_RESERVE_SHARE,
	RATER_SOURCE,
	RATER_TOKENS,
} from '../domain/rater.constants'
import type { RiskAnswer } from '../domain/risk-answer.schema'
import {
	getEngineLevel,
	getRaterChoices,
	getRaterCoverage,
	getReviewGap,
	mergeRiskAnswers,
	type RatingGap,
	type ReviewGapReport,
} from '../domain/risk-rating.helper'
import type { RatingBinding, RiskRating } from '../domain/risk-rating.types'
import { parseRiskAnswer } from '../infrastructure/risk-answer.parser'
import { FloorDiffService } from './floor-diff.service'
import { RATER_PROMPT } from './rater.prompt'

/** One rater conversation: its first message, its unfiltered scope and the files it must read. */
interface RaterJob {
	readonly user: string
	readonly scope: RepoScope
	readonly coverage: LoopCoverage<RiskAnswer>
	readonly tokensPerRun: number
}

/** Unread paths a coverage gap names before it counts the rest. */
const MAX_LISTED_UNREAD = 10

/** A reviewed change to rate: the rules at the base commit, the change, its plan and the review. */
export interface RateRequest {
	readonly rules: Rules
	readonly change: Change
	readonly pr: PullRequestInfo
	readonly plan: Plan
	readonly review: ReviewOutcome & ReviewGapReport
	/** The highest level an earlier rating of the pull request published; `none` when unknown. */
	readonly previous?: StatusLevel
}

/** The change with no file left out, so the rater's tools reach `skip.paths` and binaries too. */
function toUnfilteredChange(change: Change): Change {
	return {
		...change,
		files: change.files.map(({ skipped: _skipped, ...file }) => file),
	}
}

/** The pull request without the text its author controls: no title and no description. */
function toCodeOnlyPullRequest(pr: PullRequestInfo): PullRequestInfo {
	const { title: _title, body: _body, ...rest } = pr
	return rest
}

/** The paths a coverage gap names, the rest counted. */
function toUnreadDetail(unread: readonly string[]): string {
	const listed = unread.slice(0, MAX_LISTED_UNREAD).join(', ')
	const rest = unread.length - MAX_LISTED_UNREAD
	return `the rater did not read ${unread.length} changed file(s) whole: ${listed}${rest > 0 ? ` and ${rest} more` : ''}`
}

/** The unrated rating for `gap`, its detail cut to `MAX_RISK_DETAIL_CHARS`. */
function unrated(binding: RatingBinding, gap: RatingGap): RiskRating {
	return {
		...binding,
		status: 'unrated',
		reason: gap.reason,
		detail: toCutLine(gap.detail, MAX_RISK_DETAIL_CHARS),
	}
}

/**
 * Rates a reviewed change after Validate: one fresh agent on `risk.model` (the validator's model
 * by default) reads the rubric, every changed file, the budgeted diff of the complete, unfiltered
 * change, the floors, the kept findings and the earlier rating, never the title, description,
 * comments or commit messages, and answers with `report_risk`. The rating counts only when the
 * engine's read check passes over every changed file: each hunk in its first message or in what
 * its tools showed whole. A review with any finder that failed, only partly ran or was
 * budget-stopped, a binary outside `risk.assets`, an answer the token budget forced, a coverage
 * gap, a malformed answer or a failed model leaves the change unrated; the service never fails and
 * never rates Low in place of a rating it could not make.
 */
export class RaterService extends Context.Service<
	RaterService,
	{ readonly rate: (request: RateRequest) => Effect.Effect<RiskRating> }
>()('mng-review/RaterService') {}

export const RaterServiceLive = Layer.effect(
	RaterService,
	Effect.gen(function* () {
		const loop = yield* AgentLoopService
		const health = yield* ModelHealthService
		const git = yield* GitService
		const floorDiff = yield* FloorDiffService

		const askModel = (model: ModelSetting, job: RaterJob) =>
			loop
				.run({
					model,
					system: RATER_PROMPT,
					user: job.user,
					scope: job.scope,
					tools: RATER_REPO_TOOLS,
					finish: ReportRiskTool.name,
					parse: parseRiskAnswer,
					budget: {
						runTokens: job.tokensPerRun,
						conversationTokens: RATER_TOKENS,
						reserve: Math.floor(RATER_TOKENS * RATER_RESERVE_SHARE),
					},
					source: RATER_SOURCE,
					coverage: job.coverage,
				})
				.pipe(Effect.map(result => ({ result, model: model.model })))

		/** The rater's answer on the first model still available, moving on when one is dropped. */
		const ask = (
			models: readonly ModelSetting[],
			job: RaterJob
		): ReturnType<typeof askModel> =>
			Effect.gen(function* () {
				const dropped = yield* health.dropped
				const [model, ...rest] = models.filter(
					entry => !dropped.some(drop => drop.model === entry.model)
				)
				if (!model) return yield* new LoopError({ reason: NO_RATER_MODEL })
				return yield* askModel(model, job).pipe(
					Effect.catchTag('ModelDroppedError', () => ask(rest, job))
				)
			})

		const rateCovered = Effect.fn('RaterService.rateCovered')(function* (
			request: RateRequest,
			binding: RatingBinding
		) {
			const { rules } = request
			const change = toUnfilteredChange(request.change)
			const diff = yield* git.readDiff(change, change.files)
			const whole = getWholePaths(diff, MAX_FULL_DIFF_CHARS)
			const user = toRaterMessage({
				rubric: rules.risk?.rubric ?? '',
				floors: binding.floors,
				previous: request.previous ?? 'none',
				files: request.change.files,
				diff,
				maxChars: MAX_FULL_DIFF_CHARS,
				findings: [...request.review.bugs, ...request.review.nits],
			})
			const coverage: LoopCoverage<RiskAnswer> = {
				paths: getRaterCoverage(change.files, whole),
				changed: getChangedLines(diff),
				answered: () => [],
				merge: mergeRiskAnswers,
			}
			const { result, model } = yield* ask(getRaterChoices(rules.config), {
				user,
				scope: { change, pr: toCodeOnlyPullRequest(request.pr) },
				coverage,
				tokensPerRun: rules.config.limits.tokens_per_run,
			})
			if (result.budgetStopped)
				return unrated(binding, {
					reason: 'budget-stopped',
					detail: 'the token budget forced the rater to answer',
				})
			const unread = result.unread ?? []
			if (unread.length > 0)
				return unrated(binding, {
					reason: 'coverage-gap',
					detail: toUnreadDetail(unread),
				})
			const { value } = result
			return {
				...binding,
				status: 'rated',
				level: getEngineLevel(value.level, {
					floors: binding.floors,
					plan: request.plan,
					bugs: request.review.bugs,
				}),
				model: value.level,
				reasons: value.reasons,
				refs: value.refs,
				...(value.up ? { up: value.up } : {}),
				...(value.down ? { down: value.down } : {}),
				rater: model,
			} satisfies RiskRating
		})

		const rate = Effect.fn('RaterService.rate')(function* (
			request: RateRequest
		) {
			const { rules, change } = request
			const { risk } = rules.config
			const range = { base: change.mergeBase, head: change.head.commit }
			const bound = {
				...range,
				rules: toRulesDigest(rules.risk?.rubric ?? '', risk),
				floors: [],
				floor: false,
			} satisfies RatingBinding
			const read = yield* Effect.result(floorDiff.read(range))
			if (Result.isFailure(read))
				return unrated(bound, {
					reason: 'run-failed',
					detail: `git could not read the floor diff: ${read.failure.message}`,
				})
			const report = getFloorReport(read.success, {
				floors: risk.floors,
				assets: risk.assets,
				rulesPaths: rules.risk?.paths ?? [],
			})
			const binding = {
				...bound,
				floors: report.hits,
				floor: report.hits.length > 0,
			} satisfies RatingBinding
			const gap = getReviewGap(request.review)
			if (gap) return unrated(binding, gap)
			if (report.opaque.length > 0)
				return unrated(binding, {
					reason: 'opaque-binary',
					detail: `binary files outside risk.assets: ${report.opaque.join(', ')}`,
				})
			return yield* rateCovered(request, binding).pipe(
				Effect.catchTag('GitError', error =>
					Effect.succeed(
						unrated(binding, {
							reason: 'run-failed',
							detail: `git could not read the diff: ${error.message}`,
						})
					)
				),
				Effect.catchTag('TokenBudgetError', error =>
					Effect.succeed(
						unrated(binding, {
							reason: 'budget-stopped',
							detail: error.message,
						})
					)
				),
				// A git, model or answer failure, a defect included, leaves the change unrated.
				Effect.catchCause(cause =>
					Effect.succeed(
						unrated(binding, {
							reason: 'rater-failed',
							detail: toCauseMessage(cause),
						})
					)
				)
			)
		})

		return { rate }
	})
)
