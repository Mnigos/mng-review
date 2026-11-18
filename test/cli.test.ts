import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { runCli } from '../src/cli/main.ts'
import type { PlanReport } from '../src/cli/format-plan.ts'
import { response, ScriptedLlm } from './support/fakes.ts'
import { TempRepo } from './support/git.ts'

function router() {
  return new ScriptedLlm([response({ content: '{"risk":"normal","add":[]}' })])
}

describe('plan CLI', () => {
  let repo: TempRepo
  let base: string
  beforeEach(async () => {
    repo = await TempRepo.create()
    await repo.write('.mng/review.yml', 'comments: {max_nits: 3}')
    await repo.write(
      '.mng/agents/auth.md',
      '---\nkind: bug\nwhen: {paths: [packages/auth/**]}\n---\n@/docs/auth.md#Rules',
    )
    await repo.write('docs/auth.md', '# Guide\n## Rules\nCheck ownership.\n## Other\nSkip this.')
    await repo.write('packages/auth/session.ts', 'old\n')
    base = await repo.commit('base rules')
    await repo.git('checkout', '-b', 'feature')
    await repo.write('packages/auth/session.ts', 'new\n')
    await repo.commit('change')
  })
  afterEach(async () => {
    await repo?.cleanup()
  })

  async function run(args: string[], llm = router()) {
    const stdout: string[] = []
    const stderr: string[] = []
    const exit = await runCli(args, {
      cwd: repo.root,
      env: {},
      llm,
      stdout: text => stdout.push(text),
      stderr: text => stderr.push(text),
    })
    return { exit, out: stdout.join('\n'), err: stderr.join('\n'), llm }
  }
  test('plan --base main prints text and exits 0 with the injected LLM', async () => {
    const result = await run(['plan', '--base', 'main'])
    expect(result.exit).toBe(0)
    expect(result.err).toBe('')
    expect(result.out).toContain('Base main')
    expect(result.out).toContain('Changed files: 1')
    expect(result.out).toContain('Risk: normal (router)')
    expect(result.out).toContain('Depth: balanced')
    expect(result.out).toContain('Will run (2):')
    expect(result.out).toContain('reviewer')
    expect(result.out).toContain('auth')
    expect(result.llm.requests).toHaveLength(1)
  })
  test('--json prints a structured plan, files and tokens', async () => {
    const result = await run(['plan', '--base', 'main', '--json'])
    expect(result.exit).toBe(0)
    expect(result.err).toBe('')
    const report = JSON.parse(result.out) as PlanReport
    expect(report.base).toEqual({ ref: 'main', commit: base })
    expect(report.mergeBase).toBe(base)
    expect(report.skipped).toBeNull()
    expect(report.risk).toEqual({ level: 'normal', source: 'router', riskPaths: [] })
    expect(report.runs.map(entry => entry.name)).toEqual(['reviewer', 'auth'])
    expect(report.files).toMatchObject([
      { path: 'packages/auth/session.ts', status: 'modified', additions: 1, deletions: 1 },
    ])
    expect(report.tokens).toEqual({
      'gpt-6-luna': { calls: 1, promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    })
  })
  test('plan --json lists both reviewer runs in order on a risky change', async () => {
    const llm = new ScriptedLlm([response({ content: '{"risk":"risky","add":[]}' })])
    const result = await run(['plan', '--base', 'main', '--json'], llm)
    expect(result.exit).toBe(0)
    expect(result.err).toBe('')
    const report = JSON.parse(result.out) as PlanReport
    expect(report.risk).toEqual({ level: 'risky', source: 'router', riskPaths: [] })
    expect(report.depth.level).toBe('deep')
    expect(
      report.runs.map(({ name, role, model, effort }) => ({ name, role, model, effort })),
    ).toEqual([
      { name: 'reviewer', role: 'reviewer', model: 'gpt-6.1-sol', effort: 'high' },
      { name: 'reviewer', role: 'reviewer', model: 'claude-opus-5-5', effort: 'high' },
      { name: 'auth', role: 'agent', model: 'gpt-6.1-sol', effort: 'high' },
    ])
    expect(report.runs.every(entry => entry.files.includes('packages/auth/session.ts'))).toBe(true)
    expect(llm.requests).toHaveLength(1)
  })
  test('unknown review.yml key exits 2 and names the dotted key on stderr', async () => {
    await repo.write('.mng/review.yml', 'comments: {max_nit: 2}')
    const result = await run(['plan', '--base', 'main'])
    expect(result.exit).toBe(2)
    expect(result.out).toBe('')
    expect(result.err).toContain('comments.max_nit')
    expect(result.llm.requests).toHaveLength(0)
  })
  test.each([
    [['plan'], '--base is required'],
    [['review', '--base', 'main'], 'unknown command "review"'],
    [['plan', '--base', 'main', '--unknown'], 'Unknown option'],
  ])('invalid arguments %p exit 2', async (args, message) => {
    const result = await run([...args])
    expect(result.exit).toBe(2)
    expect(result.out).toBe('')
    expect(result.err).toContain(message)
    expect(result.llm.requests).toHaveLength(0)
  })
  test('--no-router never calls injected LLM and reports its explicit fallback', async () => {
    const result = await run(['plan', '--base', 'main', '--no-router', '--json'], new ScriptedLlm())
    expect(result.exit).toBe(0)
    const report = JSON.parse(result.out) as PlanReport
    expect(report.router).toEqual({
      status: 'failed',
      detail: 'disabled with --no-router',
      added: [],
    })
    expect(report.risk).toEqual({ level: 'normal', source: 'default', riskPaths: [] })
    expect(report.runs.map(entry => entry.name)).toEqual(['reviewer', 'auth'])
    expect(result.llm.requests).toHaveLength(0)
  })
  test('--rules-ref reads config, agents and imports from the commit, ignoring invalid working-tree replacements', async () => {
    await repo.write('.mng/review.yml', 'unknown: true')
    await repo.write('.mng/agents/auth.md', '---\nkind: invalid\n---\n@/missing.md')
    await repo.write('.mng/agents/untracked.md', 'not front matter')
    await repo.remove('docs/auth.md')
    const result = await run(['plan', '--base', 'main', '--rules-ref', base, '--json'])
    expect(result.exit).toBe(0)
    expect(result.err).toBe('')
    const report = JSON.parse(result.out) as PlanReport
    expect(report.runs.map(entry => entry.name)).toEqual(['reviewer', 'auth'])
    // Without rules-ref the same injected invocation must use the working tree and reject it.
    const workingTree = await run(['plan', '--base', 'main'])
    expect(workingTree.exit).toBe(2)
    expect(workingTree.llm.requests).toHaveLength(0)
  })
  test('--label skip-review skips the whole run and the LLM', async () => {
    const result = await run(
      ['plan', '--base', 'main', '--label', 'skip-review', '--json'],
      new ScriptedLlm(),
    )
    expect(result.exit).toBe(0)
    const report = JSON.parse(result.out) as PlanReport
    expect(report.skipped).toBe('label skip-review is in skip.labels')
    expect(report.runs).toEqual([])
    expect(report.router.status).toBe('skipped')
    expect(result.llm.requests).toHaveLength(0)
  })
  test('CLI manual trigger activates manual features and forwards repeated labels, author and target', async () => {
    await repo.write('.mng/review.yml', 'features: {reviewer: manual, agents: manual}')
    await repo.write(
      '.mng/agents/auth.md',
      '---\nkind: bug\nwhen: {labels: [security], authors: [alice], targets: [release]}\n---\nCheck ownership.',
    )
    const result = await run([
      'plan',
      '--base',
      'main',
      '--json',
      '--author',
      'alice',
      '--target',
      'release',
      '--label',
      'other',
      '--label',
      'security',
    ])
    expect(result.exit).toBe(0)
    expect((JSON.parse(result.out) as PlanReport).runs.map(entry => entry.name)).toEqual([
      'reviewer',
      'auth',
    ])
  })
})
