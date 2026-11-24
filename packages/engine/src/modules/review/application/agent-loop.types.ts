import type { ModelSetting } from '@mng-review/domain'
import type { Effect } from 'effect'
import type { Prompt, Response } from 'effect/ai'
import type { LoopBudget, SpentTokens } from '../domain/loop-budget.helper'
import type { UnreadFile } from '../domain/review-report.types'
import type { ToolResult } from './repo-tools.types'
import type { RepoToolName } from './repo.toolkit'
import type { ReportFindingsTool } from './report-findings.tool'
import type { ReportReplyTool } from './report-reply.tool'
import type { ReportRiskTool } from './report-risk.tool'
import type { ReportVerdictTool } from './report-verdict.tool'
import type { RepoScope } from './services/repo-tools.service'

export type FinishToolName =
	| typeof ReportFindingsTool.name
	| typeof ReportVerdictTool.name
	| typeof ReportReplyTool.name
	| typeof ReportRiskTool.name

/**
 * A repository call of a turn and the output the agent received; a refused one starts `error:`.
 * `shown` comes from the tool, only for an output the agent received.
 */
export interface ToolOutput extends ToolResult {
	readonly call: Response.ToolCallPart<string, unknown>
}

/** A problem with an answer, told back to the model. */
export interface AnswerProblem {
	readonly message: string
}

/** One agent run: its prompts, its model, the tools it may call and how its answer is read. */
export interface LoopRequest<TValue> {
	readonly model: ModelSetting
	readonly system: string
	readonly user: string
	readonly scope: RepoScope
	/** Repository tools this agent may call. */
	readonly tools: readonly RepoToolName[]
	/** The tool the agent calls once with its answer. */
	readonly finish: FinishToolName
	/** Reads the finish tool's arguments or a plain JSON answer. */
	readonly parse: (answer: unknown) => Effect.Effect<TValue, AnswerProblem>
	/** When the agent must answer for tokens; without it, only `limits.tokens_per_run` stops it. */
	readonly budget?: LoopBudget
	/** Who the turns' tokens count for in the ledger, a finder's name or `validator`; none counts none. */
	readonly source?: string
	/** Files the agent must read with a tool before it answers; see `LoopCoverage`. */
	readonly coverage?: LoopCoverage<TValue>
	/** Sees each turn's repository calls with the outputs the agent received. */
	readonly onToolOutputs?: (
		outputs: readonly ToolOutput[]
	) => Effect.Effect<void>
}

/**
 * A finder that answers without receiving some of `paths` whole gets one continuation turn naming
 * them, while its budget, tool calls and time allow. A file counts as received whole only when
 * every page of its diff came back, or `read_file` at the head showed every line of `changed`
 * (`isWholeRead`); the continuation and the files left unread in the result use the same test. The
 * first answer is kept, and `merge` adds what the continuation finds.
 */
export interface LoopCoverage<TValue> {
	readonly paths: readonly string[]
	/** The head lines each path changes (`getChangedLines`). */
	readonly changed: ReadonlyMap<string, readonly number[]>
	readonly merge: (first: TValue, next: TValue) => TValue
}

/** An agent's answer and what it took. */
export interface LoopResult<TValue> extends SpentTokens {
	readonly value: TValue
	readonly toolCalls: number
	readonly turns: number
	/** The agent got a continuation turn for files it had not read. */
	readonly continued?: boolean
	/** Files of the request's coverage the agent did not receive whole, with why; unset without coverage. */
	readonly unread?: readonly UnreadFile[]
	/** The token budget forced an answer this result holds, the first one of a continuation included. */
	readonly budgetStopped?: true
}

/** Where a loop stands between turns. */
export interface LoopState {
	readonly toolCalls: number
	readonly corrections: number
	readonly wrapUpSent: boolean
	readonly turn: number
	/** Messages the next turn sends: tool results and corrections. */
	readonly pending: readonly Prompt.MessageEncoded[]
	/** Input tokens of the conversation's first call, once it answered. */
	readonly firstMessageTokens?: number
	/** Tokens this conversation has spent. */
	readonly spentTokens: number
	/** Estimated input of the next call; see `ConversationTokens`. */
	readonly nextInputTokens: number
	/** The token budget forced a turn; it stays set through corrections, so a later answer keeps it. */
	readonly budgetForced?: true
}
