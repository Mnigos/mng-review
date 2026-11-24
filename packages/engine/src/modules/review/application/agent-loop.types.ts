import type { ModelSetting } from '@mng-review/domain'
import type { Effect } from 'effect'
import type { Prompt, Response } from 'effect/ai'
import type { LoopBudget, SpentTokens } from '../domain/loop-budget.helper'
import type { ToolResult } from './repo-tools.types'
import type { RepoToolName } from './repo.toolkit'
import type { ReportFindingsTool } from './report-findings.tool'
import type { ReportReplyTool } from './report-reply.tool'
import type { ReportVerdictTool } from './report-verdict.tool'
import type { RepoScope } from './services/repo-tools.service'

export type FinishToolName =
	| typeof ReportFindingsTool.name
	| typeof ReportVerdictTool.name
	| typeof ReportReplyTool.name

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
 * A finder that answers without reading some of `paths` (with `read_file`, `diff` or `blame`, or a
 * finding on them) gets one continuation turn naming them, while its budget, tool calls and time
 * allow. The first answer is kept, and `merge` adds what the continuation finds. The files it
 * leaves unread in the result are stricter: only every page of a file's diff, or `read_file` at the
 * head showing every line of `changed`, counts (`isWholeRead`).
 */
export interface LoopCoverage<TValue> {
	readonly paths: readonly string[]
	/** The head lines each path changes (`getChangedLines`). */
	readonly changed: ReadonlyMap<string, readonly number[]>
	/** Paths the answer itself shows the agent looked at, such as its findings' paths. */
	readonly answered: (value: TValue) => readonly string[]
	readonly merge: (first: TValue, next: TValue) => TValue
}

/** An agent's answer and what it took. */
export interface LoopResult<TValue> extends SpentTokens {
	readonly value: TValue
	readonly toolCalls: number
	readonly turns: number
	/** The agent got a continuation turn for files it had not read. */
	readonly continued?: boolean
	/** Files of the request's coverage the agent did not receive whole (`isWholeRead`); unset without coverage. */
	readonly unread?: readonly string[]
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
}
