import { describe, expect, test } from 'bun:test'
import { featureActive, gateRun } from '../src/routing/context.ts'
import { depthIsFixed, resolveDepth } from '../src/routing/depth.ts'
import { matches, matchesAny } from '../src/routing/glob.ts'
import { riskPathHits, selectByRules } from '../src/routing/select.ts'
import { agent, config, file, pr } from './support/fakes.ts'

describe('globs', () => {
  test.each([
    ['dir', 'dir/**', true],
    ['dir/a.ts', 'dir/**', true],
    ['dir/sub/a.ts', 'dir/**', true],
    ['directory/a.ts', 'dir/**', false],
    ['x.ts', '*.ts', true],
    ['src/x.ts', '*.ts', true],
    ['packages/auth/src/x.ts', 'x.ts', true],
    ['src/x.js', 'x.ts', false],
    ['x.ts', '**/x.ts', true],
    ['src/x.ts', '**/x.ts', true],
    ['a/b/x.ts', '**/x.ts', true],
    ['a/b/y.ts', '**/x.ts', false],
  ] as const)('matches(%s, %s) = %s', (path, pattern, expected) => {
    expect(matches(path, pattern)).toBe(expected)
  })
  test('matches any listed glob and handles empty lists', () => {
    expect(matchesAny('src/billing/x.ts', ['docs/**', 'src/billing/**'])).toBe(true)
    expect(matchesAny('x.ts', [])).toBe(false)
  })
})

describe('whole-run gate', () => {
  test.each([
    [pr({ fork: true }), 'skip.forks'],
    [pr({ draft: true }), 'skip.drafts'],
    [pr({ author: 'dependabot[bot]' }), 'skip.authors'],
    [pr({ author: 'renovate[bot]' }), 'skip.authors'],
    [pr({ labels: ['skip-review'] }), 'skip.labels'],
    [pr({ target: 'release' }), 'skip.targets'],
  ])('gates %p', (info, reason) => {
    expect(gateRun(config('skip: {targets: [release]}'), info)).toContain(reason)
  })
  test('allows ordinary PRs and disabled fork/draft checks', () => {
    expect(gateRun(config(), pr())).toBeNull()
    expect(
      gateRun(config('skip: {forks: false, drafts: false}'), pr({ fork: true, draft: true })),
    ).toBeNull()
    expect(gateRun(config(), pr({ author: undefined, target: undefined }))).toBeNull()
  })
  test('always_review overrides draft and skip.labels together', () => {
    expect(gateRun(config(), pr({ draft: true, labels: ['skip-review', 'review'] }))).toBeNull()
  })
  test.each([
    [pr({ fork: true, labels: ['review'] }), 'skip.forks'],
    [pr({ author: 'dependabot[bot]', labels: ['review'] }), 'skip.authors'],
    [pr({ target: 'release', labels: ['review'] }), 'skip.targets'],
  ])('always_review cannot override %s', (info, reason) => {
    expect(gateRun(config('skip: {targets: [release]}'), info)).toContain(reason)
  })
})

describe('feature modes', () => {
  for (const trigger of ['auto', 'manual'] as const) {
    for (const forced of [false, true]) {
      test(`${trigger} trigger, always_review=${forced}`, () => {
        const info = pr({ trigger, labels: forced ? ['review'] : [] })
        expect(featureActive('always', config(), info)).toBe(true)
        expect(featureActive('off', config(), info)).toBe(false)
        expect(featureActive('manual', config(), info)).toBe(trigger === 'manual' || forced)
      })
    }
  }
})

describe('selection matrix', () => {
  const files = [
    file('packages/auth/session.ts'),
    file('packages/auth/session.spec.ts'),
    file('src/billing/invoice.ts'),
  ]
  test.each([
    [
      { paths: ['packages/auth/**'] },
      pr(),
      ['packages/auth/session.ts', 'packages/auth/session.spec.ts'],
    ],
    [{ exclude: ['**/*.spec.ts'] }, pr(), ['packages/auth/session.ts', 'src/billing/invoice.ts']],
    [{ labels: ['security', 'urgent'] }, pr({ labels: ['urgent'] }), files.map(f => f.path)],
    [{ authors: ['alice'] }, pr(), files.map(f => f.path)],
    [{ targets: ['main'] }, pr(), files.map(f => f.path)],
    [{}, pr(), files.map(f => f.path)],
  ])('matches each rule independently: %p', (when, info, expected) => {
    expect(selectByRules(agent('auth', { when }), files, info)).toEqual({
      selected: true,
      files: expected,
    })
  })
  // All 16 combinations catch OR-ing lists or silently ignoring one of the metadata lists.
  for (let mask = 0; mask < 16; mask++) {
    test(`requires every nonempty list to match, bit mask ${mask}`, () => {
      const selection = selectByRules(
        agent('auth', {
          when: {
            paths: [mask & 1 ? 'packages/auth/**' : 'missing/**'],
            labels: ['security', 'urgent'],
            authors: ['alice'],
            targets: ['main'],
            triage: 'ownership changes',
            exclude: ['**/*.spec.ts'],
          },
        }),
        files,
        pr({
          labels: mask & 2 ? ['urgent'] : [],
          author: mask & 4 ? 'alice' : 'bob',
          target: mask & 8 ? 'main' : 'release',
        }),
      )
      expect(selection.selected).toBe(mask === 15)
      if (mask === 15) expect(selection.files).toEqual(['packages/auth/session.ts'])
      if (!selection.selected) expect(selection.routable).toBe(mask === 14)
    })
  }
  test('excluded files cannot satisfy paths and are not offered to the router', () => {
    const selection = selectByRules(
      agent('auth', {
        when: {
          paths: ['packages/auth/**'],
          exclude: ['packages/auth/**'],
          triage: 'ownership changes',
        },
      }),
      files,
      pr(),
    )
    expect(selection).toMatchObject({
      selected: false,
      routable: true,
      files: ['src/billing/invoice.ts'],
    })
  })
  test.each(['skip.paths', 'binary', 'too_large'] as const)(
    'skipped files (%s) never match or become candidates',
    skipped => {
      const skippedFiles = [file('packages/auth/session.ts', { skipped })]
      expect(
        selectByRules(
          agent('auth', { when: { paths: ['packages/auth/**'], triage: 'ownership' } }),
          skippedFiles,
          pr(),
        ),
      ).toMatchObject({ selected: false, routable: false, files: [] })
      expect(selectByRules(agent(), skippedFiles, pr())).toMatchObject({
        selected: false,
        routable: false,
      })
    },
  )
  test('only a paths-only failure with triage and reviewable scope is routable', () => {
    expect(
      selectByRules(agent('auth', { when: { paths: ['other/**'] } }), files, pr()),
    ).toMatchObject({ selected: false, routable: false })
    expect(
      selectByRules(
        agent('auth', { when: { paths: ['other/**'], triage: 'ownership' } }),
        [],
        pr(),
      ),
    ).toMatchObject({ selected: false, routable: false })
    expect(
      selectByRules(
        agent('auth', { when: { paths: ['other/**'], triage: 'ownership' } }),
        files,
        pr(),
      ),
    ).toMatchObject({ selected: false, routable: true, files: files.map(f => f.path) })
  })
  test('metadata with no paths runs without reviewable files, but other inputs and explicit paths do not', () => {
    const empty = [file('ignored.ts', { skipped: 'skip.paths' })]
    expect(selectByRules(agent('meta', { input: 'metadata' }), empty, pr())).toEqual({
      selected: true,
      files: [],
    })
    expect(
      selectByRules(
        agent('meta', { input: 'metadata', when: { labels: ['urgent'] } }),
        empty,
        pr(),
      ),
    ).toMatchObject({ selected: false, routable: false })
    expect(
      selectByRules(
        agent('meta', { input: 'metadata', when: { paths: ['ignored.ts'] } }),
        empty,
        pr(),
      ),
    ).toMatchObject({ selected: false, routable: false })
    expect(selectByRules(agent('auth', { input: 'full_diff' }), empty, pr())).toMatchObject({
      selected: false,
      routable: false,
    })
  })
  test('absent author/target cannot satisfy a nonempty list', () => {
    expect(
      selectByRules(
        agent('auth', { when: { authors: ['alice'] } }),
        files,
        pr({ author: undefined }),
      ).selected,
    ).toBe(false)
    expect(
      selectByRules(
        agent('auth', { when: { targets: ['main'] } }),
        files,
        pr({ target: undefined }),
      ).selected,
    ).toBe(false)
  })
  test('riskPathHits includes only reviewable matching files', () => {
    expect(
      riskPathHits(
        [...files, file('packages/auth/ignored.ts', { skipped: 'binary' })],
        ['packages/auth/**'],
      ),
    ).toEqual(['packages/auth/session.ts', 'packages/auth/session.spec.ts'])
    expect(riskPathHits(files, [])).toEqual([])
  })
})

describe('depth precedence', () => {
  test('risk paths override deep/quick labels and a fixed quick setting', () => {
    const cfg = config('depth: quick')
    const info = pr({ labels: ['mng-review-deep', 'mng-review-quick'] })
    expect(resolveDepth(cfg, info, 'trivial', ['src/billing/invoice.ts'])).toEqual({
      depth: 'deep',
      source: 'risk_paths',
    })
    expect(depthIsFixed(cfg, info, ['src/billing/invoice.ts'])).toBe(true)
  })
  test('deep label wins over quick label and fixed setting', () => {
    expect(
      resolveDepth(
        config('depth: balanced'),
        pr({ labels: ['mng-review-quick', 'mng-review-deep'] }),
        'trivial',
        [],
      ),
    ).toEqual({ depth: 'deep', source: 'label mng-review-deep' })
  })
  test('quick label wins over fixed deep setting and risky rating', () => {
    expect(
      resolveDepth(config('depth: deep'), pr({ labels: ['mng-review-quick'] }), 'risky', []),
    ).toEqual({ depth: 'quick', source: 'label mng-review-quick' })
  })
  test.each(['quick', 'balanced', 'deep'] as const)('fixed %s overrides risk', depth => {
    expect(resolveDepth(config(`depth: ${depth}`), pr(), 'risky', [])).toEqual({
      depth,
      source: 'review.yml depth',
    })
    expect(depthIsFixed(config(`depth: ${depth}`), pr(), [])).toBe(true)
  })
  test.each([
    ['trivial', 'quick'],
    ['normal', 'balanced'],
    ['risky', 'deep'],
  ] as const)('maps risk %s to %s', (risk, depth) => {
    expect(resolveDepth(config(), pr(), risk, [])).toEqual({ depth, source: `risk ${risk}` })
    expect(depthIsFixed(config(), pr(), [])).toBe(false)
  })
  test.each(['mng-review-deep', 'mng-review-quick'])('label %s fixes depth', label => {
    expect(depthIsFixed(config(), pr({ labels: [label] }), [])).toBe(true)
  })
})
