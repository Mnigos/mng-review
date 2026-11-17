import type { HttpClientOptions } from '../../src/llm/http.ts'
import type { ChatRequest } from '../../src/llm/types.ts'

export const chatRequest: ChatRequest = {
  model: 'model-a',
  messages: [{ role: 'user', content: 'Review the change.' }],
}
export const endpoint = 'https://llm.example.invalid/v1'
export const fakeKey = 'test-key-not-a-real-credential'
export function completion(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    model: 'provider-model',
    choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    ...overrides,
  })
}
export function fakeFetch(
  impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return impl as typeof fetch
}
export function httpOptions(fetch: typeof globalThis.fetch): HttpClientOptions {
  return {
    url: endpoint,
    fetch,
    timeoutMs: 100,
    retryDelayMs: 1,
    maxRetryAfterMs: 30,
    concurrency: 2,
  }
}
