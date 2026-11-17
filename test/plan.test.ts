import { describe, expect, mock, test } from 'bun:test'
import { buildPlan, type PlanInput } from '../src/routing/plan.ts'
import type { RouterInput, RouterOutcome } from '../src/routing/router.ts'
import { agent, config, file, pr } from './support/fakes.ts'

function planInput(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    config: config(),
    files: [file()],
    agents: [],
    pr: pr(),
    route: null,
    diff: async () => '+ changed',
    ...overrides,
  }
}
const normal = (): RouterOutcome => ({ status: 'ok', risk: 'normal', added: [] })

describe('buildPlan', () => {
  test('keeps rule-selected agents and only adds router selections', async () => {
    const pathAgent = agent('auth', { when: { paths: ['packages/auth/**'] } })
    const candidate = agent('billing', {
      when: { paths: ['src/billing/**'], triage: 'changes invoices' },
    })
    const blocked = agent('other', {
      when: { paths: ['other/**'], authors: ['bob'], triage: 'other' },
    })
    const route = mock(async (_input: RouterInput): Promise<RouterOutcome> => ({
      status: 'ok',
      risk: 'normal',
      added: [{ agent: 'billing', reason: 'Touches invoices across files.' }],
    }))
    const plan = await buildPlan(planInput({ agents: [pathAgent, candidate, blocked], route }))
    expect(route).toHaveBeenCalledTimes(1)
    expect(route.mock.calls[0]?.[0]).toMatchObject({
      candidates: [{ name: 'billing', triage: 'changes invoices' }],
      diff: '+ changed',
    })
    expect(plan.runs.map(run => [run.name, run.selectedBy])).toEqual([
      ['reviewer', 'default'],
      ['auth', 'paths'],
      ['billing', 'router'],
    ])
    expect(plan.runs.find(run => run.name === 'billing')).toMatchObject({
      files: ['packages/auth/session.ts'],
      reason: 'Touches invoices across files.',
    })
    expect(plan.skips).toContainEqual({
      name: 'other',
      title: 'other',
      reason: 'author not in when.authors',
    })
    expect(plan).toMatchObject({ risk: 'normal', riskSource: 'router', depth: 'balanced' })
  })
  test('an empty router selection cannot remove an agent selected by paths', async () => {
    const plan = await buildPlan(
      planInput({
        agents: [agent('auth', { when: { paths: ['packages/auth/**'] } })],
        route: async () => normal(),
      }),
    )
    expect(plan.runs.map(run => run.name)).toEqual(['reviewer', 'auth'])
  })
  test('router failure falls back to path selection and normal risk', async () => {
    const plan = await buildPlan(
      planInput({
        agents: [
          agent('auth'),
          agent('billing', { when: { paths: ['src/billing/**'], triage: 'invoices' } }),
        ],
        route: async () => ({ status: 'failed', error: 'malformed answer' }),
      }),
    )
    expect(plan).toMatchObject({
      risk: 'normal',
      riskSource: 'default',
      depth: 'balanced',
      router: { status: 'failed', detail: 'malformed answer', added: [] },
    })
    expect(plan.runs.map(run => run.name)).toEqual(['reviewer', 'auth'])
    expect(plan.skips.find(skip => skip.name === 'billing')?.reason).toContain('router failed')
  })
  test('risk_paths forces risky/deep even against a trivial router rating, quick label and quick config', async () => {
    const route = mock(async (_input: RouterInput): Promise<RouterOutcome> => ({
      status: 'ok',
      risk: 'trivial',
      added: [],
    }))
    const plan = await buildPlan(
      planInput({
        config: config('risk_paths: [packages/auth/**]\ndepth: quick'),
        pr: pr({ labels: ['mng-review-quick'] }),
        route,
        agents: [agent('billing', { when: { paths: ['src/billing/**'], triage: 'invoices' } })],
      }),
    )
    expect(route).toHaveBeenCalledTimes(1)
    expect(plan).toMatchObject({
      risk: 'risky',
      riskSource: 'risk_paths',
      depth: 'deep',
      riskPathHits: ['packages/auth/session.ts'],
    })
  })
  test('quick depth skips reviewer and all non-metadata agents', async () => {
    const plan = await buildPlan(
      planInput({
        agents: [
          agent('auth'),
          agent('nits', { kind: 'nit', input: 'full_diff' }),
          agent('meta', { input: 'metadata' }),
        ],
        route: async () => ({ status: 'ok', risk: 'trivial', added: [] }),
      }),
    )
    expect(plan.runs.map(run => run.name)).toEqual(['meta'])
    expect(plan.skips.map(skip => skip.name)).toEqual(['reviewer', 'auth', 'nits'])
    expect(plan.skips.every(skip => skip.reason.includes('metadata agents only'))).toBe(true)
  })
  test('deep raises reviewer and bug efforts but leaves explicit efforts and nit effort intact', async () => {
    const plan = await buildPlan(
      planInput({
        config: config('depth: deep'),
        agents: [
          agent('auth'),
          agent('explicit', { effort: 'low' }),
          agent('nits', { kind: 'nit' }),
        ],
      }),
    )
    expect(plan.runs.map(run => [run.name, run.effort])).toEqual([
      ['reviewer', 'high'],
      ['auth', 'high'],
      ['explicit', 'low'],
      ['nits', 'medium'],
    ])
  })
  test.each(['reviewer', 'agents'] as const)(
    'features.%s off only disables that role',
    async feature => {
      const plan = await buildPlan(
        planInput({
          config: config(`features: {${feature}: off}`),
          agents: [agent()],
          route: async () => normal(),
        }),
      )
      expect(plan.runs.map(run => run.name)).toEqual(
        feature === 'reviewer' ? ['auth'] : ['reviewer'],
      )
      expect(
        plan.skips.find(skip => skip.name === (feature === 'reviewer' ? 'reviewer' : 'auth'))
          ?.reason,
      ).toBe(`features.${feature} is off`)
    },
  )
  for (const feature of ['reviewer', 'agents'] as const) {
    for (const trigger of ['auto', 'manual'] as const) {
      for (const forced of [false, true]) {
        test(`features.${feature} manual, trigger=${trigger}, forced=${forced}`, async () => {
          const plan = await buildPlan(
            planInput({
              config: config(`features: {${feature}: manual}`),
              agents: [agent()],
              pr: pr({ trigger, labels: forced ? ['review'] : [] }),
              route: async () => normal(),
            }),
          )
          const name = feature === 'reviewer' ? 'reviewer' : 'auth'
          expect(plan.runs.some(run => run.name === name)).toBe(trigger === 'manual' || forced)
        })
      }
    }
  }
  test('disabled agents are never offered to the router', async () => {
    const route = mock(async (_input: RouterInput): Promise<RouterOutcome> => normal())
    await buildPlan(
      planInput({
        config: config('features: {agents: off}'),
        agents: [agent('billing', { when: { paths: ['src/billing/**'], triage: 'invoices' } })],
        route,
      }),
    )
    expect(route.mock.calls[0]?.[0]).toMatchObject({ candidates: [] })
  })
  test('whole-run gate skips without calling the router or reading the diff', async () => {
    const route = mock(async (_input: RouterInput): Promise<RouterOutcome> => normal())
    const diff = mock(async () => '+ changed')
    const plan = await buildPlan(
      planInput({ agents: [agent()], pr: pr({ labels: ['skip-review'] }), route, diff }),
    )
    expect(plan).toMatchObject({
      skippedRun: 'label skip-review is in skip.labels',
      runs: [],
      skips: [],
      router: { status: 'skipped' },
    })
    expect(route).not.toHaveBeenCalled()
    expect(diff).not.toHaveBeenCalled()
  })
  test.each([{ files: [] }, { files: [file('image.bin', { skipped: 'binary' })] }])(
    'no reviewable files skips router but still permits metadata agents: %p',
    async ({ files }) => {
      const route = mock(async (_input: RouterInput): Promise<RouterOutcome> => normal())
      const diff = mock(async () => '+ changed')
      const plan = await buildPlan(
        planInput({
          files: [...files],
          agents: [agent('meta', { input: 'metadata' })],
          route,
          diff,
        }),
      )
      expect(route).not.toHaveBeenCalled()
      expect(diff).not.toHaveBeenCalled()
      expect(plan).toMatchObject({
        risk: 'trivial',
        depth: 'quick',
        router: { status: 'skipped', detail: 'no reviewable files' },
      })
      expect(plan.runs.map(run => [run.name, run.files])).toEqual([['meta', []]])
    },
  )
  test('fixed depth with no candidates avoids both router and diff', async () => {
    const route = mock(async (_input: RouterInput): Promise<RouterOutcome> => normal())
    const diff = mock(async () => '+ changed')
    const plan = await buildPlan(planInput({ config: config('depth: balanced'), route, diff }))
    expect(plan.router).toMatchObject({
      status: 'skipped',
      detail: 'depth is fixed and no agent is left to add',
    })
    expect(route).not.toHaveBeenCalled()
    expect(diff).not.toHaveBeenCalled()
  })
  test('fixed depth still consults router when candidates remain', async () => {
    const route = mock(async (_input: RouterInput): Promise<RouterOutcome> => normal())
    await buildPlan(
      planInput({
        config: config('depth: balanced'),
        agents: [agent('billing', { when: { paths: ['src/billing/**'], triage: 'invoices' } })],
        route,
      }),
    )
    expect(route).toHaveBeenCalledTimes(1)
  })
  test.each([undefined, 'disabled with --no-router'])(
    'unavailable router reports failure with reason %p',
    async routeUnavailable => {
      const plan = await buildPlan(planInput({ routeUnavailable }))
      expect(plan.router).toEqual({
        status: 'failed',
        detail: routeUnavailable ?? 'no model endpoint',
        added: [],
      })
      expect(plan).toMatchObject({ risk: 'normal', depth: 'balanced' })
    },
  )
})
