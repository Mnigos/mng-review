import { describe, expect, test } from 'bun:test'
import { loadAgents, parseAgent, parseFrontMatter, splitFrontMatter } from '../src/agents/parse.ts'
import { expandImports, extractSection } from '../src/agents/sections.ts'
import { agentSettings, raiseEffort } from '../src/agents/settings.ts'
import { ConfigError } from '../src/errors.ts'
import { agent, config, MemoryReader } from './support/fakes.ts'

describe('agent front matter', () => {
  test.each(['---\nkind: bug\n---\nInstructions', '\uFEFF---\r\nkind: bug\r\n---\r\nInstructions'])(
    'splits LF or BOM and CRLF',
    text => {
      expect(splitFrontMatter(text, 'auth.md')).toEqual({ yaml: 'kind: bug', body: 'Instructions' })
    },
  )
  test.each(['Instructions', '---\nkind: bug\nInstructions', '\n---\nkind: bug\n---'])(
    'requires complete front matter',
    text => {
      expect(() => splitFrontMatter(text, 'auth.md')).toThrow(ConfigError)
      expect(() => splitFrontMatter(text, 'auth.md')).toThrow('auth.md: missing YAML front matter')
    },
  )
  test('defaults input, max findings, needs and every when list', () => {
    expect(parseFrontMatter('kind: bug', 'auth.md')).toEqual({
      kind: 'bug',
      input: 'incremental',
      max_findings: 8,
      needs: [],
      when: { paths: [], exclude: [], labels: [], authors: [], targets: [] },
    })
    expect(parseFrontMatter('kind: nit\nwhen: {paths: [src/**]}', 'auth.md').when).toEqual({
      paths: ['src/**'],
      exclude: [],
      labels: [],
      authors: [],
      targets: [],
    })
  })
  test.each([
    ['kind: style', 'kind'],
    ['kind: bug\ninput: patch', 'input'],
    ['kind: bug\neffort: extreme', 'effort'],
    ['kind: bug\nunknown: true', 'unknown'],
    ['kind: bug\nwhen: {unknown: []}', 'when.unknown'],
    ['kind: bug\ncomments: {max_nit: 1}', 'comments.max_nit'],
    ['kind: bug\nlimits: {concurrency: 2}', 'limits'],
    ['kind: bug\nmax_findings: 0', 'max_findings'],
    ['kind: bug\nneeds: ci', 'needs'],
    ['', 'kind'],
  ])('rejects invalid schema %s', (yaml, key) => {
    expect(() => parseFrontMatter(yaml, 'auth.md')).toThrow(ConfigError)
    expect(() => parseFrontMatter(yaml, 'auth.md')).toThrow(key)
  })
  test('rejects a front matter file limit as an unknown limits key', () => {
    const yaml = 'kind: bug\nlimits: {max_file_kb: 12}'
    const parse = () => parseFrontMatter(yaml, 'auth.md')
    expect(parse).toThrow(ConfigError)
    expect(parse).toThrow('auth.md: unknown key "limits"')
  })
  test.each(['reviewer', 'router', 'validator', 'verdict'])('reserves %s', async name => {
    await expect(
      parseAgent(name, '---\nkind: bug\n---\nCheck.', new MemoryReader()),
    ).rejects.toThrow('reserved')
  })
  test.each(['Auth', 'bad_name', '-auth', '../auth', 'auth/name', '', 'auth name'])(
    'rejects bad name %p',
    async name => {
      await expect(
        parseAgent(name, '---\nkind: bug\n---\nCheck.', new MemoryReader()),
      ).rejects.toThrow('agent names')
    },
  )
  test('uses the name as title or an explicit title and trims instructions', async () => {
    const fallback = await parseAgent('auth', '---\nkind: bug\n---\n Check. \n', new MemoryReader())
    expect(fallback).toMatchObject({
      name: 'auth',
      title: 'auth',
      file: '.mng/agents/auth.md',
      instructions: 'Check.',
    })
    expect(
      (
        await parseAgent(
          'auth',
          '---\nkind: bug\ntitle: Ownership\n---\nCheck.',
          new MemoryReader(),
        )
      ).title,
    ).toBe('Ownership')
  })
  test.each(['', ' \n\t', '@/empty.md'])('rejects empty expanded instructions %p', async body => {
    await expect(
      parseAgent('auth', `---\nkind: bug\n---\n${body}`, new MemoryReader({ 'empty.md': '' })),
    ).rejects.toThrow('no instructions')
  })
  test('missing agents directory gives no agents', async () => {
    expect(await loadAgents(new MemoryReader())).toEqual([])
  })
  test('loads only Markdown agents directly inside the directory through the reader', async () => {
    const reader = new MemoryReader({
      '.mng/agents/auth.md': '---\nkind: bug\n---\n@/docs/auth.md',
      '.mng/agents/notes.txt': 'not an agent',
      '.mng/agents/nested/other.md': 'not a direct agent',
      'docs/auth.md': 'Check ownership.',
    })
    expect((await loadAgents(reader)).map(a => [a.name, a.instructions])).toEqual([
      ['auth', 'Check ownership.'],
    ])
    expect(reader.reads).toEqual(['.mng/agents/auth.md', 'docs/auth.md'])
  })
})

describe('agent imports and sections', () => {
  const markdown =
    '# Guide\nIntro\n## Rules\nOwn the row.\n### Nested\nKeep this.\n## Other\nDo not import.'
  test('whole-file and section imports are read through the supplied reader', async () => {
    const reader = new MemoryReader({ 'docs/auth.md': markdown })
    expect(await expandImports('Before\n@/docs/auth.md\nAfter', reader, 'auth.md')).toBe(
      `Before\n${markdown}\nAfter`,
    )
    expect(await expandImports('@/docs/auth.md#Rules', reader, 'auth.md')).toBe(
      '## Rules\nOwn the row.\n### Nested\nKeep this.',
    )
    expect(reader.reads).toEqual(['docs/auth.md', 'docs/auth.md'])
  })
  test('a higher-level heading ends a section and the last section reaches EOF', () => {
    expect(extractSection('## Rules\nText\n# End\nOther', 'Rules')).toBe('## Rules\nText')
    expect(extractSection(markdown, 'Other')).toBe('## Other\nDo not import.')
    expect(extractSection(markdown, 'Missing')).toBeNull()
  })
  test.each(['```', '~~~~'])('ignores headings inside %s fenced code', fence => {
    const md = `${fence}md\n## Rules\nFake\n${fence}\n## Rules\nReal\n${fence}\n# Stop\n${fence}\n### Nested\nKept\n## End\nExcluded`
    expect(extractSection(md, 'Rules')).toBe(
      `## Rules\nReal\n${fence}\n# Stop\n${fence}\n### Nested\nKept`,
    )
  })
  test('a shorter fence does not close a longer block', () => {
    expect(extractSection('## Rules\n````\n```\n# Fake\n````\n## End', 'Rules')).toBe(
      '## Rules\n````\n```\n# Fake\n````',
    )
  })
  test.each([
    'See @/docs/auth.md for rules.',
    'prefix @/docs/auth.md',
    'Use `@/docs/auth.md#Rules`.',
  ])('leaves inline mention %s untouched', async text => {
    const reader = new MemoryReader()
    expect(await expandImports(text, reader, 'auth.md')).toBe(text)
    expect(reader.reads).toEqual([])
  })
  test('does not recursively expand imported text', async () => {
    const reader = new MemoryReader({ 'docs/auth.md': '@/other.md' })
    expect(await expandImports('@/docs/auth.md', reader, 'auth.md')).toBe('@/other.md')
    expect(reader.reads).toEqual(['docs/auth.md'])
  })
  test('names a missing file and reader source', async () => {
    await expect(expandImports('@/missing.md', new MemoryReader(), 'auth.md')).rejects.toThrow(
      'missing.md not found in in-memory base commit',
    )
  })
  test('names a missing heading', async () => {
    await expect(
      expandImports(
        '@/docs/auth.md#Missing',
        new MemoryReader({ 'docs/auth.md': markdown }),
        'auth.md',
      ),
    ).rejects.toThrow('no heading "Missing" in docs/auth.md')
  })
  test('rejects traversal before calling the reader', async () => {
    const reader = new MemoryReader()
    await expect(expandImports('@/../x', reader, 'auth.md')).rejects.toThrow(
      'outside the repository',
    )
    expect(reader.reads).toEqual([])
  })
})

describe('agent settings', () => {
  test.each(['bug', 'nit'] as const)('%s inherits the appropriate model and effort', kind => {
    const cfg = config()
    const settings = agentSettings(agent('auth', { kind }), cfg)
    const model = kind === 'bug' ? cfg.models.reviewer : cfg.models.nits
    expect(settings).toEqual({ ...model, comments: cfg.comments })
  })
  test.each(['bug', 'nit'] as const)(
    '%s front matter overrides model, effort and comments',
    kind => {
      const cfg = config()
      expect(
        agentSettings(
          agent('auth', {
            kind,
            model: 'custom',
            effort: 'low',
            comments: { max_nits: 2, summary: false },
          }),
          cfg,
        ),
      ).toEqual({
        model: 'custom',
        effort: 'low',
        comments: { min_severity: 'medium', max_nits: 2, summary: false },
      })
      expect(cfg.comments.max_nits).toBe(5)
    },
  )
  test('model and effort overrides are independent', () => {
    expect(agentSettings(agent('auth', { model: 'custom' }), config()).effort).toBe('medium')
    expect(agentSettings(agent('auth', { effort: 'low' }), config()).model).toBe('gpt-6.1-sol')
  })
  test.each([
    ['minimal', 'low'],
    ['low', 'medium'],
    ['medium', 'high'],
    ['high', 'high'],
    ['xhigh', 'xhigh'],
  ] as const)('raises %s to %s', (input, expected) => {
    expect(raiseEffort(input)).toBe(expected)
  })
})
