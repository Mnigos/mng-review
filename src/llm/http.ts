import { z } from 'zod'
import { ConfigError } from '../errors.ts'
import { Semaphore } from './semaphore.ts'
import {
  type ChatRequest,
  type ChatResponse,
  type LlmClient,
  LlmError,
  TokenLedger,
  type ToolChoice,
} from './types.ts'

export interface HttpClientOptions {
  /** Base URL of an OpenAI-compatible API, e.g. `https://host/v1`. */
  url: string
  key?: string
  timeoutMs?: number
  concurrency?: number
  /** Wait before the single retry when the server sends no usable `Retry-After`. */
  retryDelayMs?: number
  /** Longest `Retry-After` the client honours before it gives up. */
  maxRetryAfterMs?: number
  fetch?: typeof fetch
  tokens?: TokenLedger
}

export const envUrl = 'MNG_REVIEW_LLM_URL'
export const envKey = 'MNG_REVIEW_LLM_KEY'

/** Builds a client from `MNG_REVIEW_LLM_URL` and `MNG_REVIEW_LLM_KEY`. */
export function clientFromEnv(
  env: Record<string, string | undefined>,
  options: Omit<HttpClientOptions, 'url' | 'key'> = {},
): LlmClient {
  const url = env[envUrl]?.trim()
  if (!url) throw new ConfigError(`${envUrl} is not set`)
  const key = env[envKey]?.trim()
  return createHttpClient({ ...options, url, ...(key ? { key } : {}) })
}

const responseSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                type: z.literal('function').default('function'),
                function: z.object({ name: z.string(), arguments: z.string().default('') }),
              }),
            )
            .nullish(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().default(0),
      completion_tokens: z.number().default(0),
      total_tokens: z.number().optional(),
    })
    .nullish(),
})

export function createHttpClient(options: HttpClientOptions): LlmClient {
  let base: URL
  try {
    base = new URL(options.url)
  } catch {
    throw new ConfigError(`${envUrl} is not a valid URL`)
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new ConfigError(`${envUrl} must be an http or https URL`)
  }
  const endpoint = `${base.href.replace(/\/+$/, '')}/chat/completions`
  const timeoutMs = options.timeoutMs ?? 180_000
  const retryDelayMs = options.retryDelayMs ?? 2_000
  const maxRetryAfterMs = options.maxRetryAfterMs ?? 30_000
  const doFetch = options.fetch ?? fetch
  const semaphore = new Semaphore(options.concurrency ?? 4)
  const tokens = options.tokens ?? new TokenLedger()
  const secrets = [options.key, endpoint, base.href, base.host].filter((value): value is string =>
    Boolean(value),
  )
  /** Removes the key and the endpoint address from text that ends up in an error message. */
  const redact = (text: string) =>
    secrets.reduce((out, secret) => out.replaceAll(secret, '[redacted]'), text)

  const send = async (request: ChatRequest): Promise<Response> => {
    const signals = [AbortSignal.timeout(timeoutMs)]
    if (request.signal) signals.push(request.signal)
    try {
      return await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.key ? { authorization: `Bearer ${options.key}` } : {}),
        },
        body: JSON.stringify(requestBody(request)),
        signal: AbortSignal.any(signals),
      })
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      if (name === 'TimeoutError') throw new LlmError(`model call timed out after ${timeoutMs} ms`)
      if (name === 'AbortError') throw new LlmError('model call aborted')
      throw new LlmError(
        `model endpoint unreachable: ${redact(String((error as Error)?.message ?? error))}`,
      )
    }
  }

  const call = async (request: ChatRequest): Promise<ChatResponse> => {
    let response = await send(request)
    if (isRetryable(response.status)) {
      const wait = retryWait(response.headers.get('retry-after'), retryDelayMs)
      await response.body?.cancel()
      if (wait > maxRetryAfterMs) throw httpError(response.status, '', redact)
      await Bun.sleep(wait)
      response = await send(request)
    }
    const text = await response.text()
    if (!response.ok) throw httpError(response.status, text, redact)
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw new LlmError('model endpoint returned invalid JSON', response.status)
    }
    const parsed = responseSchema.safeParse(json)
    if (!parsed.success) throw new LlmError('model endpoint returned an unexpected response shape')
    const choice = parsed.data.choices[0]!
    const usage = {
      promptTokens: parsed.data.usage?.prompt_tokens ?? 0,
      completionTokens: parsed.data.usage?.completion_tokens ?? 0,
      totalTokens:
        parsed.data.usage?.total_tokens ??
        (parsed.data.usage?.prompt_tokens ?? 0) + (parsed.data.usage?.completion_tokens ?? 0),
    }
    tokens.add(request.model, usage)
    return {
      model: parsed.data.model ?? request.model,
      content: choice.message.content ?? null,
      toolCalls: choice.message.tool_calls ?? [],
      finishReason: choice.finish_reason ?? null,
      usage,
    }
  }

  return { tokens, chat: request => semaphore.run(() => call(request)) }
}

function requestBody(request: ChatRequest): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages,
    ...(request.effort ? { reasoning_effort: request.effort } : {}),
    ...(request.tools?.length ? { tools: request.tools } : {}),
    ...(request.toolChoice ? { tool_choice: toolChoice(request.toolChoice) } : {}),
    ...(request.maxTokens ? { max_completion_tokens: request.maxTokens } : {}),
  }
}

function toolChoice(choice: ToolChoice): unknown {
  return typeof choice === 'string' ? choice : { type: 'function', function: { name: choice.name } }
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500
}

/** Parses `Retry-After` (seconds or an HTTP date). */
export function retryWait(header: string | null, fallbackMs: number): number {
  if (!header) return fallbackMs
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(header)
  return Number.isNaN(date) ? fallbackMs : Math.max(0, date - Date.now())
}

function httpError(status: number, body: string, redact: (text: string) => string): LlmError {
  const detail = redact(body).replace(/\s+/g, ' ').trim().slice(0, 200)
  return new LlmError(`model endpoint answered ${status}${detail ? `: ${detail}` : ''}`, status)
}
