import { describe, expect, test } from 'bun:test'
import { clientFromEnv, createHttpClient, retryWait } from '../src/llm/http.ts'
import { ConfigError } from '../src/errors.ts'
import { LlmError, TokenLedger, type ToolChoice } from '../src/llm/types.ts'
import {
  chatRequest,
  completion,
  endpoint,
  fakeFetch,
  fakeKey,
  httpOptions,
} from './support/http.ts'

describe('HTTP request contract', () => {
  test.each(['required', 'auto', 'none', { name: 'route' }] satisfies ToolChoice[])(
    'serializes tool choice %p and all request fields',
    async toolChoice => {
      const calls: Array<{ url: string; init?: RequestInit }> = []
      const fetch = fakeFetch(async (url, init) => {
        calls.push({ url: String(url), init })
        return completion()
      })
      const client = createHttpClient({ ...httpOptions(fetch), key: fakeKey })
      const tools = [
        {
          type: 'function' as const,
          function: { name: 'route', description: 'Route', parameters: { type: 'object' } },
        },
      ]
      const request = { ...chatRequest, tools, toolChoice, effort: 'high' as const, maxTokens: 123 }
      const result = await client.chat(request)
      expect(calls).toHaveLength(1)
      const call = calls[0]!
      expect(call.url).toBe(`${endpoint}/chat/completions`)
      expect(call.init?.method).toBe('POST')
      expect(new Headers(call.init?.headers).get('authorization')).toBe(`Bearer ${fakeKey}`)
      expect(new Headers(call.init?.headers).get('content-type')).toBe('application/json')
      expect(JSON.parse(String(call.init?.body))).toEqual({
        model: 'model-a',
        messages: request.messages,
        tools,
        tool_choice:
          typeof toolChoice === 'string'
            ? toolChoice
            : { type: 'function', function: { name: 'route' } },
        reasoning_effort: 'high',
        max_completion_tokens: 123,
      })
      expect(result).toEqual({
        model: 'provider-model',
        content: 'done',
        toolCalls: [],
        finishReason: 'stop',
        usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
      })
    },
  )
  test.each([undefined, ''])(
    'omits authorization for absent/empty key %p and omits optional body fields',
    async key => {
      const fetch = fakeFetch(async (_url, init) => {
        expect(new Headers(init?.headers).has('authorization')).toBe(false)
        expect(JSON.parse(String(init?.body))).toEqual({
          model: 'model-a',
          messages: chatRequest.messages,
        })
        return completion()
      })
      await createHttpClient({ ...httpOptions(fetch), key }).chat(chatRequest)
    },
  )
  test('normalizes a trailing slash and maps tool calls', async () => {
    const fetch = fakeFetch(async url => {
      expect(String(url)).toBe(`${endpoint}/chat/completions`)
      return completion({
        model: undefined,
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: '1',
                  type: 'function',
                  function: { name: 'route', arguments: '{"risk":"normal"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })
    })
    expect(
      await createHttpClient({ ...httpOptions(fetch), url: `${endpoint}/` }).chat(chatRequest),
    ).toMatchObject({
      model: 'model-a',
      content: null,
      toolCalls: [
        { id: '1', type: 'function', function: { name: 'route', arguments: '{"risk":"normal"}' } },
      ],
      finishReason: 'tool_calls',
    })
  })
})

describe('HTTP retry policy', () => {
  test.each([429, 500, 502, 503])(
    'retries %s exactly once and accounts only successful tokens',
    async status => {
      let calls = 0
      const fetch = fakeFetch(async () =>
        ++calls === 1 ? new Response('temporary error', { status }) : completion(),
      )
      const client = createHttpClient(httpOptions(fetch))
      await client.chat(chatRequest)
      expect(calls).toBe(2)
      expect(client.tokens.byModel()).toEqual({
        'model-a': { calls: 1, promptTokens: 7, completionTokens: 3, totalTokens: 10 },
      })
    },
  )
  test.each([429, 500, 503])('does not make a third call after repeated %s', async status => {
    let calls = 0
    const fetch = fakeFetch(async () => {
      calls++
      return new Response('still unavailable', { status })
    })
    const client = createHttpClient(httpOptions(fetch))
    await expect(client.chat(chatRequest)).rejects.toThrow(`model endpoint answered ${status}`)
    expect(calls).toBe(2)
    expect(client.tokens.total()).toBe(0)
  })
  test.each([400, 401, 403, 404, 408, 422])('does not retry %s', async status => {
    let calls = 0
    const fetch = fakeFetch(async () => {
      calls++
      return new Response('rejected', { status })
    })
    await expect(createHttpClient(httpOptions(fetch)).chat(chatRequest)).rejects.toMatchObject({
      name: 'LlmError',
      status,
    })
    expect(calls).toBe(1)
  })
  test('honours Retry-After seconds before issuing the retry', async () => {
    const starts: number[] = []
    const fetch = fakeFetch(async () => {
      starts.push(performance.now())
      return starts.length === 1
        ? new Response('busy', { status: 429, headers: { 'Retry-After': '0.02' } })
        : completion()
    })
    await createHttpClient(httpOptions(fetch)).chat(chatRequest)
    expect(starts).toHaveLength(2)
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(19)
  })
  test('too-long Retry-After fails fast instead of waiting or sending another request', async () => {
    let calls = 0
    const fetch = fakeFetch(async () => {
      calls++
      return new Response('busy', { status: 429, headers: { 'Retry-After': '3600' } })
    })
    await expect(createHttpClient(httpOptions(fetch)).chat(chatRequest)).rejects.toThrow('429')
    expect(calls).toBe(1)
  }, 1000)
  test('retryWait handles seconds, HTTP dates, negative and invalid values', () => {
    expect(retryWait('2', 1)).toBe(2000)
    expect(retryWait('0.01', 1)).toBe(10)
    expect(retryWait('-1', 1)).toBe(0)
    expect(retryWait(null, 7)).toBe(7)
    expect(retryWait('invalid', 7)).toBe(7)
    expect(retryWait(new Date(Date.now() - 1000).toUTCString(), 1)).toBe(0)
  })
})

describe('HTTP errors and cancellation', () => {
  test('times out a pending fetch without retrying it', async () => {
    let calls = 0
    const fetch = fakeFetch(async (_url, init) => {
      calls++
      const signal = init!.signal!
      return new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    await expect(
      createHttpClient({ ...httpOptions(fetch), timeoutMs: 5 }).chat(chatRequest),
    ).rejects.toThrow('timed out after 5 ms')
    expect(calls).toBe(1)
  })
  test('honours an explicit caller abort', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetch = fakeFetch(async (_url, init) => {
      init!.signal!.throwIfAborted()
      return completion()
    })
    await expect(
      createHttpClient(httpOptions(fetch)).chat({ ...chatRequest, signal: controller.signal }),
    ).rejects.toThrow('model call aborted')
  })
  test('rejects invalid JSON and does not record tokens or retry', async () => {
    let calls = 0
    const fetch = fakeFetch(async () => {
      calls++
      return new Response('not JSON')
    })
    const client = createHttpClient(httpOptions(fetch))
    await expect(client.chat(chatRequest)).rejects.toThrow('invalid JSON')
    expect(calls).toBe(1)
    expect(client.tokens.total()).toBe(0)
  })
  test.each([{}, { choices: [] }, { choices: [{ message: { content: 42 } }] }])(
    'rejects invalid response shape %p',
    async body => {
      await expect(
        createHttpClient(httpOptions(fakeFetch(async () => Response.json(body)))).chat(chatRequest),
      ).rejects.toThrow('unexpected response shape')
    },
  )
  test.each([400, 401, 500])(
    'ordinary error messages for %s contain neither key nor endpoint',
    async status => {
      const client = createHttpClient({
        ...httpOptions(fakeFetch(async () => new Response('provider error', { status }))),
        key: fakeKey,
      })
      const error = await client.chat(chatRequest).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(LlmError)
      expect((error as Error).message).not.toContain(fakeKey)
      expect((error as Error).message).not.toContain(endpoint)
    },
  )
})

describe('tokens and concurrency', () => {
  test('accumulates tokens by requested model, supports missing total_tokens and isolates ledger snapshots', async () => {
    const tokens = new TokenLedger()
    const fetch = fakeFetch(async () =>
      completion({ usage: { prompt_tokens: 4, completion_tokens: 2 } }),
    )
    const client = createHttpClient({ ...httpOptions(fetch), tokens })
    await client.chat(chatRequest)
    await client.chat(chatRequest)
    await client.chat({ ...chatRequest, model: 'model-b' })
    expect(client.tokens).toBe(tokens)
    expect(tokens.byModel()).toEqual({
      'model-a': { calls: 2, promptTokens: 8, completionTokens: 4, totalTokens: 12 },
      'model-b': { calls: 1, promptTokens: 4, completionTokens: 2, totalTokens: 6 },
    })
    expect(tokens.total()).toBe(18)
    tokens.byModel()['model-a']!.calls = 999
    expect(tokens.byModel()['model-a']!.calls).toBe(2)
  })
  test('missing usage gives zero token counts and still records the call', async () => {
    const client = createHttpClient(httpOptions(fakeFetch(async () => completion({ usage: null }))))
    await client.chat(chatRequest)
    expect(client.tokens.byModel()).toEqual({
      'model-a': { calls: 1, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    })
  })
  test('limits simultaneous in-flight fetches and releases slots after failures', async () => {
    const entered = Array.from({ length: 5 }, () => Promise.withResolvers<void>())
    const release = Array.from({ length: 5 }, () => Promise.withResolvers<void>())
    let active = 0
    let peak = 0
    let calls = 0
    const fetch = fakeFetch(async () => {
      const index = calls++
      active++
      peak = Math.max(peak, active)
      entered[index]!.resolve()
      try {
        await release[index]!.promise
        return index === 0 ? new Response('bad request', { status: 400 }) : completion()
      } finally {
        active--
      }
    })
    const client = createHttpClient({ ...httpOptions(fetch), timeoutMs: 1000, concurrency: 2 })
    // Attach rejection handlers immediately so the intentional first failure is never unhandled.
    const outcomes = Promise.allSettled(Array.from({ length: 5 }, () => client.chat(chatRequest)))
    try {
      await Promise.all([entered[0]!.promise, entered[1]!.promise])
      expect(calls).toBe(2)
      expect(active).toBe(2)
      release[0]!.resolve()
      await entered[2]!.promise
      expect(calls).toBe(3)
      expect(active).toBe(2)
      release[1]!.resolve()
      await entered[3]!.promise
      release[2]!.resolve()
      await entered[4]!.promise
      expect(peak).toBe(2)
    } finally {
      release.forEach(gate => gate.resolve())
    }
    const results = await outcomes
    expect(results.map(r => r.status)).toEqual([
      'rejected',
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ])
    expect(active).toBe(0)
  })
})

describe('clientFromEnv with explicit test environment', () => {
  test.each([{}, { MNG_REVIEW_LLM_URL: '' }, { MNG_REVIEW_LLM_URL: '  ' }])(
    'rejects a missing URL %p',
    env => {
      expect(() => clientFromEnv(env, { fetch: fakeFetch(async () => completion()) })).toThrow(
        ConfigError,
      )
    },
  )
  test.each(['not a URL', 'file:///tmp/endpoint', 'ftp://example.invalid'])(
    'rejects invalid URL %s without echoing it',
    url => {
      try {
        clientFromEnv(
          { MNG_REVIEW_LLM_URL: url, MNG_REVIEW_LLM_KEY: fakeKey },
          { fetch: fakeFetch(async () => completion()) },
        )
        throw new Error('expected invalid URL to fail')
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError)
        expect((error as Error).message).not.toContain(url)
        expect((error as Error).message).not.toContain(fakeKey)
      }
    },
  )
  test('uses only supplied URL/key values and the injected fetch', async () => {
    const fetch = fakeFetch(async (url, init) => {
      expect(String(url)).toBe(`${endpoint}/chat/completions`)
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${fakeKey}`)
      return completion()
    })
    await clientFromEnv(
      { MNG_REVIEW_LLM_URL: ` ${endpoint} `, MNG_REVIEW_LLM_KEY: ` ${fakeKey} ` },
      { fetch },
    ).chat(chatRequest)
  })
})
