import { afterEach, describe, expect, test } from 'bun:test'
import { parseNumstat, readChange } from '../src/change/change.ts'
import { Git } from '../src/git/git.ts'
import { createHttpClient } from '../src/llm/http.ts'
import { runRouter } from '../src/routing/router.ts'
import { config, file, ScriptedLlm } from './support/fakes.ts'
import { TempRepo } from './support/git.ts'
import { chatRequest, endpoint, fakeFetch, fakeKey, httpOptions } from './support/http.ts'

describe('regressions', () => {
  test('HTTP response errors redact the configured key and URL', async () => {
    const fetch = fakeFetch(
      async () => new Response(`Rejected ${fakeKey} at ${endpoint}`, { status: 401 }),
    )
    const client = createHttpClient({ ...httpOptions(fetch), key: fakeKey })
    const error = await client.chat(chatRequest).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain(fakeKey)
    expect((error as Error).message).not.toContain(endpoint)
  })
  test('fetch exceptions redact the configured key and URL', async () => {
    const fetch = fakeFetch(async () => {
      throw new Error(`Failed ${endpoint} using ${fakeKey}`)
    })
    const client = createHttpClient({ ...httpOptions(fetch), key: fakeKey })
    const error = await client.chat(chatRequest).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain(endpoint)
    expect((error as Error).message).not.toContain(fakeKey)
  })
  test('router never throws when the LLM rejects with null', async () => {
    const llm = new ScriptedLlm()
    llm.chat = () => Promise.reject(null)
    const outcome = await runRouter(llm, config().models.router, {
      files: [file()],
      candidates: [],
      diff: '+ changed',
    })
    expect(outcome.status).toBe('failed')
  })
  test('NUL numstat preserves tabs inside a file name', () => {
    const counts = parseNumstat('1\t2\tsrc/with\ttab.ts\0')
    expect(Object.fromEntries(counts)).toEqual({
      'src/with\ttab.ts': { additions: 1, deletions: 2, binary: false },
    })
  })
  let repo: TempRepo | undefined
  afterEach(async () => {
    await repo?.cleanup()
    repo = undefined
  })
  test('readChange gets blob sizes for newline-containing paths', async () => {
    repo = await TempRepo.create()
    await repo.write('README.md', 'base\n')
    await repo.commit('base')
    await repo.git('checkout', '-b', 'feature')
    await repo.write('src/line\nbreak.ts', 'hello\n')
    await repo.commit('add newline path')
    const change = await readChange(await Git.open(repo.root), 'main', 'HEAD')
    expect(change.files).toEqual([
      file('src/line\nbreak.ts', { status: 'added', additions: 1, deletions: 0, sizeBytes: 6 }),
    ])
  })
})
