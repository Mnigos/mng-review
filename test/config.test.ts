import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../src/config/load.ts'
import { deepMerge } from '../src/config/merge.ts'
import type { Config } from '../src/config/schema.ts'
import { defaultPreset } from '../src/config/preset.ts'
import { ConfigError } from '../src/errors.ts'

// Literal contract copied from review.yml in docs/spec.md, not from the implementation.
const specDefaults: Config = {
  extends: 'mng:default',
  features: { reviewer: 'always', agents: 'always', verdict: 'always' },
  depth: 'auto',
  risk_paths: [],
  comments: { min_severity: 'medium', max_nits: 5, summary: true },
  limits: {
    max_runs_per_pr: 6,
    max_file_kb: 300,
    tokens_per_run: 1500000,
    tokens_per_pr: 5000000,
    concurrency: 4,
  },
  skip: {
    drafts: true,
    forks: true,
    authors: ['dependabot[bot]', 'renovate[bot]'],
    labels: ['skip-review'],
    targets: [],
    paths: [],
  },
  labels: {
    always_review: ['review'],
    depth: { quick: 'mng-review-quick', deep: 'mng-review-deep' },
  },
  disputes: { accept_intentional_up_to: 'medium', max_rounds: 1 },
  verdict: { blocking_severity: 'medium', mode: 'preview', never_approve: [] },
  models: {
    router: { model: 'gpt-6-luna', effort: 'low' },
    reviewer: { model: 'gpt-6.1-sol', effort: 'medium' },
    nits: { model: 'gpt-6.1-terra', effort: 'medium' },
    validator: { model: 'gpt-6.1-sol', effort: 'high' },
    fallback: null,
  },
}

describe('parseConfig', () => {
  test.each([null, '', '   \n', '# only a comment\n', '{}', 'extends: mng:default'])(
    'uses every spec default for %p',
    text => {
      expect(parseConfig(text)).toEqual(specDefaults)
      expect(defaultPreset).toEqual(specDefaults)
    },
  )
  test('merges partial settings while keeping other defaults and isolating parsed results', () => {
    const parsed = parseConfig(
      'comments: {max_nits: 2}\nmodels: {router: {model: custom}}\nskip: {authors: []}',
    )
    expect(parsed.comments).toEqual({ min_severity: 'medium', max_nits: 2, summary: true })
    expect(parsed.models.router).toEqual({ model: 'custom', effort: 'low' })
    expect(parsed.skip.authors).toEqual([])
    parsed.labels.always_review.push('custom')
    expect(parseConfig(null)).toEqual(specDefaults)
  })
  test.each([
    ['typo: true', 'typo'],
    ['comments: {max_nit: 3}', 'comments.max_nit'],
    ['models: {router: {temp: 0.2}}', 'models.router.temp'],
    ['skip: {unknown: []}', 'skip.unknown'],
    ['limits: {concurrency: 0}', 'limits.concurrency'],
    ['comments: {summary: "yes"}', 'comments.summary'],
    ['comments: {max_nits: 1.5}', 'comments.max_nits'],
    ['features: {agents: sometimes}', 'features.agents'],
    ['risk_paths: src/auth', 'risk_paths'],
    ['depth: extreme', 'depth'],
    ['models: {fallback: 2}', 'models.fallback'],
    ['skip: {forks: null}', 'skip.forks'],
    ['extends: local', 'extends'],
    ['extends: 42', 'extends'],
  ])('rejects %s and names %s', (yaml, key) => {
    expect(() => parseConfig(yaml)).toThrow(ConfigError)
    expect(() => parseConfig(yaml)).toThrow(key)
  })
  test('reports invalid YAML with its source', () => {
    expect(() => parseConfig('comments: [', 'rules.yml')).toThrow(ConfigError)
    expect(() => parseConfig('comments: [', 'rules.yml')).toThrow('rules.yml: invalid YAML')
  })
  test.each(['[]', '- item', 'true', '42', 'text'])('rejects non-mapping %s', yaml => {
    expect(() => parseConfig(yaml)).toThrow('expected a mapping at the top level')
  })
})

describe('deepMerge', () => {
  test('merges objects, replaces arrays/scalars/null, and does not mutate either input', () => {
    const base = {
      nested: { kept: 1, replaced: 2 },
      list: ['a', 'b'],
      scalar: 'a',
      nullable: { x: 1 },
    }
    const override = {
      nested: { replaced: 3, added: true },
      list: ['c'],
      scalar: false,
      nullable: null,
    }
    const before = structuredClone({ base, override })
    expect(deepMerge<unknown>(base, override)).toEqual({
      nested: { kept: 1, replaced: 3, added: true },
      list: ['c'],
      scalar: false,
      nullable: null,
    })
    expect({ base, override }).toEqual(before)
  })
  test.each([
    [undefined, { x: 1 }],
    [null, null],
    [[1], [1]],
    [false, false],
    ['text', 'text'],
    [0, 0],
  ])('replaces at the root with %p', (override, expected) => {
    expect(deepMerge<unknown>({ x: 1 }, override)).toEqual(expected)
  })
  test('undefined leaves existing fields intact', () => {
    expect(deepMerge({ x: 1 }, { x: undefined })).toEqual({ x: 1 })
  })
})
