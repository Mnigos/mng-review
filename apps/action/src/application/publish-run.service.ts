import { type Rules, RulesService } from '@mng-review/engine'
import {
	type CommandRun,
	type DismissalOutcome,
	getAnsweredOpenThreads,
	GitHubConfig,
	provideOwnedIdentities,
	type PublishIncompleteError,
	type PublishResult,
	PublishService,
	type RatingBlock,
	type ReplyPublishResult,
	ReplyPublishService,
	type RiskTarget,
	type StatusReportResult,
	StatusReportService,
	SummaryReviewService,
	type SummaryWriteError,
	toTrustedPlacement,
} from '@mng-review/github'
import { Context, Effect, Layer } from 'effect'
import type {
	OutcomeFile,
	OutcomeReplies,
} from '../infrastructure/outcome-file.schema'
import type { RiskRunSettings } from '../infrastructure/risk-run.config'
import {
	getConverseReplies,
	isUnpublished,
	toFailed,
	toRiskField,
	toRiskSettings,
	toRulesReason,
	toStatusWriteError,
} from './publish-report.helper'
import { getRiskGate, getSettingsGate, type RiskGate } from './risk-gate.helper'
import { type RiskReport, RiskRunService } from './risk-run.service'
import { getGateReason } from './run-gate.helper'
import type { PullRequestEvent } from './shadow-run.types'

/**
 * What publishing trusts besides the outcome file: which engine posts, named in every marker, and
 * the pull request and head from the runner and the event, which the file's binding was checked
 * against.
 */
export interface PublishContext {
	readonly engineCommit: string | undefined
	readonly pullNumber: number
	readonly head: string
	/**
	 * The pull request as this job's own event payload gives it, or for a command as read again
	 * from the API, for the base rules' gates.
	 */
	readonly event: Pick<PullRequestEvent, 'action' | 'pr'>
	/** Set for a command run, from the job's trusted context; never from the outcome file. */
	readonly command?: CommandRun
	/** A reply schedule run, from the job's trusted trigger: only a replied outcome publishes. */
	readonly converse?: boolean
	/** The app's environment and the default branch; without them nothing is rated. */
	readonly risk?: RiskRunSettings
	/** The workflow run id; with a rating, every answer names the comments it handled. */
	readonly run?: number
	/** A dispatched converse's reply, answered in a resolved thread too. */
	readonly held?: number
}

/** A failure after the rules loaded, which the report says and the rating may fail on. */
type PublishFailure = SummaryWriteError | PublishIncompleteError

/** What publishing did with an outcome. */
export type PublishReport =
	| {
			readonly status: 'published'
			readonly result: PublishResult
			/** Check runs written and whether the commit status was set. */
			readonly checks: StatusReportResult
			readonly risk?: RiskReport
	  }
	| {
			readonly status: 'status-only'
			readonly reason: string
			/** `false` when an existing summary review was edited instead of a new one posted. */
			readonly posted: boolean
			/** Owned approvals that outlived their head, dismissed or not. */
			readonly dismissal: DismissalOutcome
	  }
	| {
			readonly status: 'replied'
			readonly result: ReplyPublishResult
			readonly risk?: RiskReport
	  }
	| { readonly status: 'not-published'; readonly reason: string }
	| {
			readonly status: 'failed'
			readonly reason: string
			/** Set when the rating stopped before or in step 1; the job then fails. */
			readonly risk?: RiskReport
	  }

/**
 * Publishes a parsed outcome file on its pull request: a reviewed run gets threads, the summary
 * review, a check run per agent and the `MNG Review` commit status, also when no finder had to
 * run (the re-check's proposals and the status still matter); an offline endpoint gets the
 * summary when there is none and an `error` status; a reply schedule run gets its answers
 * (`ReplyPublishService`) and nothing else. The rules name the bot identities whose
 * earlier threads and summary count. A skip, an invalid configuration or a git failure posts nothing; the job summary and the job's exit code report them. The rules are
 * loaded again from the binding's base commit, never taken from the file, and no model is
 * called. A GitHub or rules failure is a `failed` report; while the rating is on (or, when the
 * rules did not load, while the settings would rate) it carries a failed rating, which fails the
 * job (a refused `MNG Review` status too), and a thread run's thread raise still runs after its
 * posts failed. When the summary write fails after posting began, the status is set to `error`.
 */
export class PublishRunService extends Context.Service<
	PublishRunService,
	{
		readonly run: (
			outcome: OutcomeFile,
			context: PublishContext
		) => Effect.Effect<PublishReport>
	}
>()('mng-review/PublishRunService') {}

export const PublishRunServiceLive = Layer.effect(
	PublishRunService,
	Effect.gen(function* () {
		const publisher = yield* PublishService
		const summaries = yield* SummaryReviewService
		const statuses = yield* StatusReportService
		const replyPublisher = yield* ReplyPublishService
		const rulesService = yield* RulesService
		const riskRuns = yield* RiskRunService
		const { identity } = yield* GitHubConfig

		/** Whether the run rates under these rules for this pull request. */
		const toGate = (context: PublishContext, rules: Rules) =>
			getRiskGate({
				config: rules.config,
				identity,
				settings: toRiskSettings(context),
				pr: context.event.pr,
			})

		/** Whether the run would rate if its rules, which did not load, turned the rating on. */
		const toSettingsGate = (context: PublishContext) =>
			getSettingsGate({
				identity,
				settings: toRiskSettings(context),
				pr: context.event.pr,
			})

		/** The bot identities whose earlier threads and summary count under these rules. */
		const toOwned = (rules: Rules) =>
			provideOwnedIdentities(identity, rules.config.identity.previous)

		/**
		 * A thread run's posts, then its thread raise, which runs even when the posts failed part way;
		 * the failure then still fails the run. The target may read what the posts returned.
		 */
		const withThreadRaise = <TValue, TError, TContext>(
			posting: Effect.Effect<TValue, TError, TContext>,
			gate: RiskGate,
			toTarget: (value: TValue | undefined) => RiskTarget
		) =>
			Effect.gen(function* () {
				const posted = yield* Effect.result(posting)
				const value = posted._tag === 'Success' ? posted.success : undefined
				const risk = yield* riskRuns.rateThread(gate, toTarget(value))
				if (posted._tag === 'Failure') return yield* Effect.fail(posted.failure)
				return { value: posted.success, risk }
			})

		/** The run and held reply a rating run's answers name; none without a rating. */
		const toAnswerTarget = (context: PublishContext, rules: Rules) =>
			toGate(context, rules).status === 'on'
				? {
						...(context.run === undefined ? {} : { run: context.run }),
						...(context.held === undefined ? {} : { held: context.held }),
					}
				: {}

		/**
		 * A reply schedule run: the decisions only, with no `skip` rule or run limit, since a reply
		 * on a pull request with a skip label is still the author's question. The threads it keeps
		 * open are known before it posts, so the thread raise counts them even after a failure.
		 */
		const publishReplies = Effect.fn('PublishRunService.publishReplies')(
			function* (
				replies: OutcomeReplies,
				outcome: OutcomeFile,
				context: PublishContext,
				rules: Rules
			) {
				const answered = getAnsweredOpenThreads(replies.decided)
				const posting = replyPublisher.publish({
					pullNumber: context.pullNumber,
					head: context.head,
					engineCommit: context.engineCommit,
					rules,
					...toAnswerTarget(context, rules),
					replies: {
						decisions: replies.decided,
						base: outcome.binding.baseSha,
						tokens: replies.tokens,
					},
				})
				const { value, risk } = yield* withThreadRaise(
					posting,
					toGate(context, rules),
					result => ({
						pullNumber: context.pullNumber,
						head: context.head,
						baseSha: outcome.binding.baseSha,
						defaultBranch: toRiskSettings(context).defaultBranch,
						rules,
						answered,
						...(result?.reopened ? { openBugs: result.reopened } : {}),
					})
				).pipe(toOwned(rules))
				return {
					status: 'replied',
					result: value,
					...toRiskField(risk),
				} satisfies PublishReport
			}
		)

		const publish = Effect.fn('PublishRunService.publish')(function* (
			outcome: OutcomeFile,
			context: PublishContext,
			rules: Rules
		) {
			const { report, recheck, replies } = outcome
			// The review job decided the gates too, but a file never decides whether this job writes.
			const owned = toOwned(rules)
			const gated = getGateReason(
				context.event,
				rules.config,
				yield* summaries.readPrior(context.pullNumber).pipe(owned)
			)
			if (gated !== undefined)
				return {
					status: 'not-published',
					reason: gated,
				} satisfies PublishReport
			if (outcome.status === 'reviewed' && report) {
				if (report.planReport.plan.skippedRun)
					return {
						status: 'not-published',
						reason: report.planReport.plan.skippedRun,
					} satisfies PublishReport
				const placed = toTrustedPlacement(report, rules)
				const target = {
					pullNumber: context.pullNumber,
					head: context.head,
					baseSha: outcome.binding.baseSha,
					defaultBranch: toRiskSettings(context).defaultBranch,
					rules,
				}
				const gate = toGate(context, rules)
				const agent = context.command?.agent
				const answers =
					context.run === undefined || outcome.startedAt === undefined
						? []
						: yield* riskRuns
								.readAnswers(gate, {
									pullNumber: context.pullNumber,
									run: context.run,
									before: outcome.startedAt,
									kind: agent === undefined ? 'review' : 'run',
									...(agent === undefined ? {} : { agent }),
								})
								.pipe(owned)
				// The checks and the `MNG Review` status are written inside, so the grant stays last.
				const toPublish = (rating: RatingBlock | undefined) =>
					publisher
						.publish({
							...(rating ? { rating } : {}),
							...(answers.length > 0 ? { answers } : {}),
							...toAnswerTarget(context, rules),
							pullNumber: context.pullNumber,
							report: placed,
							rules,
							head: context.head,
							engineCommit: context.engineCommit,
							...(context.command ? { command: context.command } : {}),
							...(recheck
								? {
										recheck: {
											checked: recheck.checked,
											proposals: recheck.rejected,
											tokens: recheck.tokens,
										},
									}
								: {}),
							...(replies
								? {
										replies: {
											decisions: replies.decided,
											base: outcome.binding.baseSha,
											tokens: replies.tokens,
										},
									}
								: {}),
						})
						.pipe(
							Effect.flatMap(result =>
								statuses
									.report({
										head: context.head,
										report: placed,
										verdict: result.verdict,
										openBugs: result.openBugs,
										finished: result.finished,
									})
									.pipe(Effect.map(checks => ({ result, checks })))
							),
							Effect.filterOrFail(
								({ checks }) => gate.status !== 'on' || checks.status,
								toStatusWriteError
							),
							Effect.tapErrorTag('PublishIncompleteError', () =>
								statuses.reportUnfinished(context.head)
							)
						)
				const rating = context.command?.agentOnly
					? withThreadRaise(toPublish(undefined), gate, () => target)
					: riskRuns.rateFull(gate, { ...target, report: placed }, toPublish)
				const rated = yield* rating.pipe(owned)
				const published = rated.value
				if (published === undefined)
					return {
						status: 'failed',
						reason:
							rated.risk.status === 'failed'
								? rated.risk.reason
								: 'the risk rating stopped before step 1',
						risk: rated.risk,
					} satisfies PublishReport
				return {
					status: 'published',
					...published,
					...toRiskField(rated.risk),
				} satisfies PublishReport
			}
			if (outcome.status === 'offline') {
				const reason = `Reviewer offline: ${outcome.reason ?? 'no reason given'}. Nothing was reviewed.`
				const written = yield* summaries
					.publishStatus({
						pullNumber: context.pullNumber,
						status: reason,
						head: context.head,
						engineCommit: context.engineCommit,
					})
					.pipe(owned)
				yield* statuses.reportOffline(context.head)
				return {
					status: 'status-only',
					reason,
					posted: written.created,
					dismissal: written.dismissal,
				} satisfies PublishReport
			}
			return {
				status: 'not-published',
				reason: `the run ended ${outcome.status}`,
			} satisfies PublishReport
		})

		const run = Effect.fn('PublishRunService.run')(function* (
			outcome: OutcomeFile,
			context: PublishContext
		) {
			if (isUnpublished(outcome, context))
				return {
					status: 'not-published',
					reason: `the run ended ${outcome.status}`,
				} satisfies PublishReport
			const loaded = yield* Effect.result(
				rulesService.load(outcome.binding.baseSha)
			)
			if (loaded._tag === 'Failure')
				return toFailed(toRulesReason(loaded.failure), toSettingsGate(context))
			const rules = loaded.success
			const gate = toGate(context, rules)
			const replies = getConverseReplies(outcome, context)
			const publishing: Effect.Effect<PublishReport, PublishFailure> = replies
				? publishReplies(replies, outcome, context, rules)
				: publish(outcome, context, rules)
			return yield* publishing.pipe(
				Effect.catch(error => Effect.succeed(toFailed(error.message, gate)))
			)
		})

		return { run }
	})
)
