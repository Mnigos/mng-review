import { execFileSync } from 'node:child_process'
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
	NodeChildProcessSpawner,
	NodeFileSystem,
	NodePath,
} from '@effect/platform-node-shared'
import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import type { Response } from 'effect/ai'
import {
	RulesService,
	RulesServiceLive,
} from '../../../platform/config/rules.service'
import {
	GitService,
	GitServiceLive,
	GitWorkdir,
} from '../../../platform/git/git.service'
import {
	makeScriptedLlmLayer,
	ScriptedLlm,
	type ScriptedLlmAnswer,
} from '../../../platform/llm/scripted-llm.layer'
import { TokenLedgerLive } from '../../../platform/llm/token-ledger.service'
import { toFixtureEnv } from '../../../shared/mocks/git-env.helper'
import { PlanService, PlanServiceLive } from './plan.service'
import { RouterServiceLive } from './router.service'

const roots: string[] = []
const NodeLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
const ProcessLayer = NodeChildProcessSpawner.layer.pipe(
	Layer.provide(NodeLayer)
)

/** Creates an isolated repository; all fixture commands disable hooks and signing. */
function createRepo(name = 'repo') {
	const parent = realpathSync(mkdtempSync(join(tmpdir(), 'mng-review-spec-')))
	roots.push(parent)
	const root = join(parent, name)
	mkdirSync(root)
	const git = (...args: string[]) =>
		execFileSync(
			'git',
			[
				'-c',
				'user.name=Author',
				'-c',
				'user.email=author@example.test',
				'-c',
				'commit.gpgsign=false',
				'-c',
				'core.hooksPath=/dev/null',
				...args,
			],
			{
				cwd: root,
				encoding: 'utf-8',
				env: {
					...toFixtureEnv(),
					GIT_CONFIG_GLOBAL: '/dev/null',
					GIT_CONFIG_NOSYSTEM: '1',
					GIT_TERMINAL_PROMPT: '0',
				},
			}
		).trimEnd()
	const write = (path: string, text: string | Uint8Array) => {
		const full = join(root, path)
		mkdirSync(dirname(full), { recursive: true })
		writeFileSync(full, text)
	}
	const commit = () => {
		git('add', '--all')
		git('commit', '-m', 'fixture')
		return git('rev-parse', 'HEAD')
	}
	git('init', '--initial-branch=main')
	return { root, git, write, commit }
}

afterEach(() => {
	vi.restoreAllMocks()
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true })
})

/** Builds the service against this spec's repository, without changing the process directory. */
function gitLayer(root: string) {
	return GitServiceLive.pipe(
		Layer.provide(ProcessLayer),
		Layer.provide(Layer.succeed(GitWorkdir, { cwd: root }))
	)
}

const FINISH = {
	type: 'finish',
	reason: 'stop',
	usage: { inputTokens: { total: 3 }, outputTokens: { total: 2 } },
} as const satisfies Response.PartEncoded

/** Uses real git, config and routing with an in-process model response. */
function planLayer(
	root: string,
	answer: ScriptedLlmAnswer = () =>
		Effect.succeed([{ type: 'text', text: '{"add":[]}' }, FINISH])
) {
	return PlanServiceLive.pipe(
		Layer.provideMerge(RouterServiceLive),
		Layer.provideMerge(makeScriptedLlmLayer(answer)),
		Layer.provideMerge(RulesServiceLive),
		Layer.provideMerge(gitLayer(root)),
		Layer.provideMerge(TokenLedgerLive),
		Layer.provide(NodeLayer)
	)
}

/** A base ruleset and one feature change shared by the wiring cases. */
function planRepo(config = '') {
	const repo = createRepo()
	repo.write('.mng/review.yml', config)
	repo.write(
		'.mng/agents/auth.md',
		'---\nkind: bug\nwhen: {paths: [src/auth/**]}\n---\nCheck ownership.'
	)
	repo.write(
		'.mng/agents/billing.md',
		'---\nkind: bug\nwhen: {paths: [src/billing/**], triage: invoices}\n---\nCheck invoices.'
	)
	repo.write('src/auth/session.ts', 'old\n')
	repo.commit()
	repo.git('checkout', '-b', 'feature')
	repo.write('src/auth/session.ts', 'new\n')
	repo.commit()
	return repo
}

layer(Layer.empty, { excludeTestServices: true })('PlanService', test => {
	test.effect('reports rules source, committed files and router tokens', () =>
		Effect.gen(function* () {
			const repo = planRepo()
			yield* Effect.gen(function* () {
				const rules = yield* RulesService.use(service =>
					service.load(undefined)
				)
				const report = yield* PlanService.use(service =>
					service.plan({
						rules,
						baseRef: 'main',
						headRef: 'HEAD',
						pr: { labels: [], draft: false, fork: false, trigger: 'manual' },
					})
				)
				expect(report.rulesSource).toBe('working tree')
				expect(report.change.files).toEqual([
					expect.objectContaining({
						path: 'src/auth/session.ts',
						additions: 1,
						deletions: 1,
					}),
				])
				expect(report.plan.runs.map(run => run.name)).toEqual([
					'reviewer',
					'auth',
				])
				expect(report.plan).toMatchObject({
					risk: 'normal',
					riskSource: 'router',
					depth: 'balanced',
				})
				expect(report.tokens[rules.config.models.router.model]).toEqual({
					calls: 1,
					inputTokens: 3,
					cachedInputTokens: 0,
					outputTokens: 2,
					reasoningTokens: 0,
					totalTokens: 5,
				})
			}).pipe(Effect.provide(planLayer(repo.root)))
		})
	)
	test.effect(
		'whole-run skip never calls the router model or reads a diff',
		() =>
			Effect.gen(function* () {
				const repo = planRepo()
				yield* Effect.gen(function* () {
					const git = yield* GitService
					const readDiffSpy = vi.spyOn(git, 'readDiff')
					const rules = yield* RulesService.use(service =>
						service.load(undefined)
					)
					const report = yield* PlanService.use(service =>
						service.plan({
							rules,
							baseRef: 'main',
							headRef: 'HEAD',
							pr: {
								labels: ['skip-review'],
								draft: false,
								fork: false,
								trigger: 'manual',
							},
						})
					)
					expect(report.plan).toMatchObject({
						skippedRun: 'label skip-review is in skip.labels',
						runs: [],
						router: { status: 'skipped' },
					})
					expect(readDiffSpy).not.toHaveBeenCalled()
					expect(yield* ScriptedLlm.use(script => script.calls)).toEqual([])
					expect(report.tokens).toEqual({})
				}).pipe(Effect.provide(planLayer(repo.root)))
			})
	)
	for (const binary of [false, true])
		test.effect(
			`no reviewable files skip diff/model but allow metadata agents, binary=${binary}`,
			() =>
				Effect.gen(function* () {
					const repo = createRepo()
					repo.write(
						'.mng/agents/meta.md',
						'---\nkind: bug\ninput: metadata\n---\nCheck metadata.'
					)
					repo.write('README.md', 'base')
					const base = repo.commit()
					if (binary) {
						repo.write('image.bin', new Uint8Array([0, 1, 2]))
						repo.commit()
					}
					yield* Effect.gen(function* () {
						const git = yield* GitService
						const readDiffSpy = vi.spyOn(git, 'readDiff')
						const rules = yield* RulesService.use(service =>
							service.load(undefined)
						)
						const report = yield* PlanService.use(service =>
							service.plan({
								rules,
								baseRef: base,
								headRef: 'HEAD',
								pr: {
									labels: [],
									draft: false,
									fork: false,
									trigger: 'manual',
								},
							})
						)
						expect(report.plan).toMatchObject({
							risk: 'trivial',
							depth: 'quick',
							router: { status: 'skipped', detail: 'no reviewable files' },
						})
						expect(report.plan.runs.map(run => [run.name, run.files])).toEqual([
							['meta', []],
						])
						expect(readDiffSpy).not.toHaveBeenCalled()
						expect(yield* ScriptedLlm.use(script => script.calls)).toEqual([])
						if (binary) expect(report.change.files[0]?.skipped).toBe('binary')
					}).pipe(Effect.provide(planLayer(repo.root)))
				})
		)
	test.effect(
		'router failure preserves path selection and uses normal risk',
		() =>
			Effect.gen(function* () {
				const repo = planRepo()
				yield* Effect.gen(function* () {
					const rules = yield* RulesService.use(service =>
						service.load(undefined)
					)
					const report = yield* PlanService.use(service =>
						service.plan({
							rules,
							baseRef: 'main',
							headRef: 'HEAD',
							pr: { labels: [], draft: false, fork: false, trigger: 'manual' },
						})
					)
					expect(report.plan).toMatchObject({
						risk: 'normal',
						riskSource: 'default',
						depth: 'balanced',
						router: { status: 'failed', added: [] },
					})
					expect(
						report.plan.runs.map(run => [run.name, run.selectedBy])
					).toEqual([
						['reviewer', 'default'],
						['auth', 'paths'],
					])
					expect(
						report.plan.skips.find(skip => skip.name === 'billing')?.reason
					).toContain('router failed')
				}).pipe(
					Effect.provide(
						planLayer(repo.root, () =>
							Effect.succeed([{ type: 'text', text: 'bad answer' }, FINISH])
						)
					)
				)
			})
	)
	test.effect(
		'router additions receive all reviewable files and cannot remove path selections',
		() =>
			Effect.gen(function* () {
				const repo = planRepo()
				yield* Effect.gen(function* () {
					const rules = yield* RulesService.use(service =>
						service.load(undefined)
					)
					const report = yield* PlanService.use(service =>
						service.plan({
							rules,
							baseRef: 'main',
							headRef: 'HEAD',
							pr: { labels: [], draft: false, fork: false, trigger: 'manual' },
						})
					)
					expect(report.plan.runs.map(run => [run.name, run.files])).toEqual([
						['reviewer', ['src/auth/session.ts']],
						['auth', ['src/auth/session.ts']],
						['billing', ['src/auth/session.ts']],
					])
				}).pipe(
					Effect.provide(
						planLayer(repo.root, () =>
							Effect.succeed([
								{
									type: 'text',
									text: '{"add":[{"agent":"billing","reason":"Touches invoices."}]}',
								},
								FINISH,
							])
						)
					)
				)
			})
	)
	for (const target of [undefined, 'release'])
		test.effect(
			`uses explicit target or derives it from the base: ${String(target)}`,
			() =>
				Effect.gen(function* () {
					const repo = planRepo()
					repo.write(
						'.mng/agents/auth.md',
						`---\nkind: bug\nwhen: {targets: [${target ?? 'main'}]}\n---\nCheck ownership.`
					)
					yield* Effect.gen(function* () {
						const rules = yield* RulesService.use(service =>
							service.load(undefined)
						)
						const report = yield* PlanService.use(service =>
							service.plan({
								rules,
								baseRef: 'main',
								headRef: 'HEAD',
								pr: {
									labels: [],
									draft: false,
									fork: false,
									trigger: 'manual',
									...(target === undefined ? {} : { target }),
								},
							})
						)
						expect(report.plan.runs.map(run => run.name)).toContain('auth')
					}).pipe(Effect.provide(planLayer(repo.root)))
				})
		)
	for (const depth of ['quick', 'balanced', 'deep'])
		test.effect(`fixed ${depth} still routes for risk without candidates`, () =>
			Effect.gen(function* () {
				const repo = planRepo(`depth: ${depth}\nfeatures: {agents: off}`)
				yield* Effect.gen(function* () {
					const rules = yield* RulesService.use(service =>
						service.load(undefined)
					)
					const report = yield* PlanService.use(service =>
						service.plan({
							rules,
							baseRef: 'main',
							headRef: 'HEAD',
							pr: { labels: [], draft: false, fork: false, trigger: 'manual' },
						})
					)
					expect(report.plan).toMatchObject({
						depth,
						risk: 'risky',
						riskSource: 'router',
					})
					expect(yield* ScriptedLlm.use(script => script.calls)).toHaveLength(1)
				}).pipe(
					Effect.provide(
						planLayer(repo.root, () =>
							Effect.succeed([
								{
									type: 'text',
									text: '{"signals":[{"category":"access","path":"src/auth/session.ts","reason":"Line 1 changes who may update a session."}]}',
								},
								FINISH,
							])
						)
					)
				)
			})
		)
})
