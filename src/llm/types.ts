import type { Effort } from '../config/schema.ts'

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface ToolDefinition {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export type ToolChoice = 'auto' | 'required' | 'none' | { name: string }

export interface ChatRequest {
  model: string
  effort?: Effort
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  toolChoice?: ToolChoice
  maxTokens?: number
  signal?: AbortSignal
}

export interface Usage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface ChatResponse {
  model: string
  content: string | null
  toolCalls: ToolCall[]
  finishReason: string | null
  usage: Usage
}

/** Chat completions with tool calls. The HTTP client and the test fake both implement it. */
export interface LlmClient {
  chat(request: ChatRequest): Promise<ChatResponse>
  readonly tokens: TokenLedger
}

export interface ModelTokens extends Usage {
  calls: number
}

/** Tokens spent per model in one run. */
export class TokenLedger {
  private readonly models = new Map<string, ModelTokens>()

  add(model: string, usage: Usage): void {
    const entry = this.models.get(model) ?? {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    }
    entry.calls += 1
    entry.promptTokens += usage.promptTokens
    entry.completionTokens += usage.completionTokens
    entry.totalTokens += usage.totalTokens
    this.models.set(model, entry)
  }

  byModel(): Record<string, ModelTokens> {
    return Object.fromEntries([...this.models].map(([model, entry]) => [model, { ...entry }]))
  }

  total(): number {
    let sum = 0
    for (const entry of this.models.values()) sum += entry.totalTokens
    return sum
  }
}

export class LlmError extends Error {
  override name = 'LlmError'
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}
