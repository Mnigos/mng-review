import type { PullRequestInfo } from '@mng-review/domain'
import {
	type GitService,
	makeReplyLayer,
	MAX_AGENT_WALL_TIME,
	MAX_TOOL_CALLS,
	ReplyService,
	type Rules,
	type TokenLedger,
	type TokensByModel,
} from '@mng-review/engine'
import { Context, Effect, Layer, Option } from 'effect'
import type { HttpClient } from 'effect/http'
import type { BotThread } from '../domain/publish.types'
import {
	toDecidedReplies,
	toReplyItems,
} from '../domain/thread-conversation.helper'
import type {
	DecidedThreadReply,
	PendingReply,
} from '../domain/thread-reply.schema'

/** The replies the prepare step read and what the engine decides them at. */
export interface ReplyDecisionInput {
	readonly rules: Rules
	readonly pr: PullRequestInfo
	readonly head: string
	/** The pull request's merge base at the head. */
	readonly mergeBase: string
	readonly replies: readonly PendingReply[]
	/** The bot's threads the replies were read in. */
	readonly threads: readonly BotThread[]
}

/** The decisions bound to their threads, and the job's tokens after them. */
export interface ReplyDecisions {
	readonly decided: readonly DecidedThreadReply[]
	readonly tokens: TokensByModel
}

/**
 * Decides on the authors' replies in the review job, through the engine's `ReplyService` on the
 * job's token ledger. It only decides: publishing answers after its own read. `undefined` when no
 * reply can be decided (`toReplyItems`) or no endpoint is configured; a reply the engine left
 * `seen` after a failure is left out.
 */
export class ReplyDecisionService extends Context.Service<
	ReplyDecisionService,
	{
		readonly decide: (
			input: ReplyDecisionInput
		) => Effect.Effect<ReplyDecisions | undefined>
	}
>()('mng-review/ReplyDecisionService') {}

export const ReplyDecisionServiceLive = Layer.effect(
	ReplyDecisionService,
	Effect.gen(function* () {
		const services = yield* Effect.context<
			GitService | TokenLedger | HttpClient.HttpClient
		>()

		const decide = Effect.fn('ReplyDecisionService.decide')(function* (
			input: ReplyDecisionInput
		) {
			const pairs = toReplyItems(input.replies, input.threads)
			if (pairs.length === 0) return undefined
			const { limits } = input.rules.config
			const service = yield* ReplyService.pipe(
				Effect.provide(
					makeReplyLayer({
						concurrency: limits.concurrency,
						tokensPerRun: limits.tokens_per_run,
						maxFileKb: limits.max_file_kb,
						maxToolCalls: MAX_TOOL_CALLS,
						maxWallTime: MAX_AGENT_WALL_TIME,
					})
				),
				Effect.provideContext(services),
				Effect.option
			)
			if (Option.isNone(service)) return undefined
			const report = yield* service.value.decide({
				rules: input.rules,
				headRef: input.head,
				mergeBase: input.mergeBase,
				pr: input.pr,
				items: pairs.map(pair => pair.item),
			})
			return {
				decided: toDecidedReplies(pairs, report.results),
				tokens: report.tokens,
			} satisfies ReplyDecisions
		})

		return { decide }
	})
)
