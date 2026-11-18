import { DEFAULT_PRESET } from '../../config/review-config.constants'
import {
	agent,
	config,
	file,
	mechanicalFiles,
	featureFiles,
	NORMAL_ROUTER,
	planInput,
	pr,
} from '../../shared/mocks/domain-test.helper'
import { REVIEWER_NAME } from '../routing.constants'
import { buildPlan, getPlanRouting } from './review-plan.helper'

describe('plan routing and construction', () => {
	test('keeps rule selections and only offers paths-only misses to the router', () => {
		const pathAgent = agent('auth', { when: { paths: ['packages/auth/**'] } })
		const candidate = agent('billing', {
			when: { paths: ['src/billing/**'], triage: 'changes invoices' },
		})
		const blocked = agent('other', {
			when: { paths: ['other/**'], authors: ['author-b'], triage: 'other' },
		})
		const input = planInput({ agents: [pathAgent, candidate, blocked] })
		expect(getPlanRouting(input)).toEqual({
			status: 'route',
			candidates: [candidate],
			files: input.files,
		})
		const plan = buildPlan(input, {
			status: 'ok',
			risk: 'normal',
			added: [{ agent: 'billing', reason: 'Touches invoices across files.' }],
		})
		expect(plan.runs.map(run => [run.name, run.selectedBy, run.files])).toEqual(
			[
				[REVIEWER_NAME, 'default', [file().path]],
				['auth', 'paths', [file().path]],
				['billing', 'router', [file().path]],
			]
		)
		expect(plan.runs.find(run => run.name === 'billing')?.reason).toBe(
			'Touches invoices across files.'
		)
		expect(plan.skips).toMatchObject([
			{ name: 'other', reason: 'author not in when.authors' },
		])
	})

	test('ignores additions for author-blocked, already-selected or unknown agents', () => {
		const selected = agent('auth', { when: { paths: ['packages/auth/**'] } })
		const blocked = agent('blocked', {
			when: {
				paths: ['missing/**'],
				triage: 'checks ownership',
				authors: ['author-b'],
			},
		})
		const input = planInput({ agents: [selected, blocked] })
		const plan = buildPlan(input, {
			...NORMAL_ROUTER,
			added: [
				{ agent: 'auth', reason: 'Already selected.' },
				{ agent: 'blocked', reason: 'Author should still block.' },
				{ agent: 'unknown', reason: 'Not declared.' },
			],
		})
		expect(plan.runs.filter(run => run.role === 'agent')).toMatchObject([
			{ name: 'auth', selectedBy: 'paths' },
		])
		expect(plan.runs.find(run => run.name === 'auth')).not.toHaveProperty(
			'reason'
		)
		expect(plan.skips).toMatchObject([
			{ name: 'blocked', reason: 'author not in when.authors' },
		])
	})

	for (const detail of [
		'invalid router answer',
		'diff unavailable',
		'route unavailable',
		'no model endpoint',
		'disabled with --no-router',
	])
		test(`failed router ${detail} preserves path selection and normal risk`, () => {
			const input = planInput({
				agents: [
					agent('auth', { when: { paths: ['packages/auth/**'] } }),
					agent('billing', {
						when: { paths: ['src/billing/**'], triage: 'invoices' },
					}),
				],
			})
			const router = { status: 'failed', detail, added: [] } as const
			const plan = buildPlan(input, router)
			expect(plan).toMatchObject({
				risk: 'normal',
				riskSource: 'default',
				depth: 'balanced',
				router,
			})
			expect(
				plan.runs.map(run => [run.name, run.selectedBy, run.files])
			).toEqual([
				[REVIEWER_NAME, 'default', [file().path]],
				['auth', 'paths', [file().path]],
			])
			expect(plan.skips).toMatchObject([
				{
					name: 'billing',
					reason: 'no changed file matches when.paths; router failed',
				},
			])
		})

	test('ignores failed router risk while retaining successful risk and risk path precedence', () => {
		const input = planInput({ config: config({ depth: 'auto' }) })
		const failedRouter = {
			status: 'failed',
			risk: 'trivial',
			added: [],
		} as const
		const plan = buildPlan(input, failedRouter)
		expect(plan).toMatchObject({
			risk: 'normal',
			riskSource: 'default',
			depth: 'balanced',
		})
		expect(plan.runs).toMatchObject([
			{ name: REVIEWER_NAME, role: 'reviewer', files: [file().path] },
		])
		expect(buildPlan(input, { ...failedRouter, status: 'ok' })).toMatchObject({
			risk: 'trivial',
			riskSource: 'router',
			depth: 'quick',
			runs: [],
		})
		for (const status of ['failed', 'ok'] as const)
			expect(
				buildPlan(
					{
						...input,
						config: config({ depth: 'auto', risk_paths: [file().path] }),
					},
					{ ...failedRouter, status }
				)
			).toMatchObject({
				risk: 'risky',
				riskSource: 'risk_paths',
				riskPathHits: [file().path],
				depth: 'deep',
			})
	})

	test('a successful router that omits a candidate records why it was skipped', () => {
		const input = planInput({
			agents: [
				agent('billing', {
					when: { paths: ['src/billing/**'], triage: 'invoices' },
				}),
			],
		})
		expect(buildPlan(input, NORMAL_ROUTER).skips).toMatchObject([
			{
				name: 'billing',
				reason: 'no changed file matches when.paths; the router did not add it',
			},
		])
	})

	test('a rename out of risk paths stays risky and selects the old path agent', () => {
		const input = planInput({
			config: config({ risk_paths: ['src/auth/**'] }),
			files: [
				file('src/session.ts', {
					status: 'renamed',
					oldPath: 'src/auth/session.ts',
				}),
			],
			agents: [agent('auth', { when: { paths: ['src/auth/**'] } })],
		})
		const plan = buildPlan(input, NORMAL_ROUTER)
		expect(plan).toMatchObject({
			risk: 'risky',
			riskSource: 'risk_paths',
			riskPathHits: ['src/session.ts'],
			depth: 'deep',
			depthSource: 'risk_paths',
		})
		expect(plan.runs.map(run => [run.name, run.selectedBy, run.files])).toEqual(
			[
				...input.config.models.reviewer.map(() => [
					REVIEWER_NAME,
					'default',
					['src/session.ts'],
				]),
				['auth', 'paths', ['src/session.ts']],
			]
		)
	})

	test('risk paths force risky/deep against trivial router risk, quick label and quick config', () => {
		const cfg = config({ risk_paths: ['packages/auth/**'], depth: 'quick' })
		const input = planInput({
			config: cfg,
			pr: pr({ labels: [cfg.labels.depth.quick] }),
		})
		expect(getPlanRouting(input)).toMatchObject({ status: 'route' })
		expect(
			buildPlan(input, { status: 'ok', risk: 'trivial', added: [] })
		).toMatchObject({
			risk: 'risky',
			riskSource: 'risk_paths',
			depth: 'deep',
			riskPathHits: [file().path],
		})
	})

	test('quick depth only runs metadata agents', () => {
		const plan = buildPlan(
			planInput({
				agents: [
					agent('auth'),
					agent('nits', { kind: 'nit', input: 'full_diff' }),
					agent('meta', { input: 'metadata' }),
				],
			}),
			{ status: 'ok', risk: 'trivial', added: [] }
		)
		expect(plan.runs.map(run => run.name)).toEqual(['meta'])
		expect(plan.skips.map(skip => skip.name)).toEqual([
			REVIEWER_NAME,
			'auth',
			'nits',
		])
		expect(
			plan.skips.every(skip => skip.reason.includes('metadata agents only'))
		).toBeTruthy()
	})

	test('deep raises inherited bug efforts but preserves explicit bug and nit efforts', () => {
		const cfg = config({
			depth: 'deep',
			models: { agents: { model: 'test-agent', effort: 'medium' } },
		})
		const plan = buildPlan(
			planInput({
				config: cfg,
				agents: [
					agent('auth'),
					agent('explicit', { effort: 'low' }),
					agent('nits', { kind: 'nit' }),
				],
			}),
			NORMAL_ROUTER
		)
		expect(
			plan.runs
				.filter(run => run.role === 'agent')
				.map(run => [run.name, run.effort])
		).toEqual([
			['auth', 'high'],
			['explicit', 'low'],
			['nits', 'medium'],
		])
	})

	test.each(['deep', 'balanced'] as const)(
		'%s runs reviewer models in order with their own effort',
		depth => {
			const cfg = config({
				depth,
				models: {
					reviewer: [
						{ model: 'model-a', effort: 'low' },
						{ model: 'model-b', effort: 'high' },
						{ model: 'model-c', effort: 'xhigh' },
					],
				},
			})
			const plan = buildPlan(planInput({ config: cfg }), NORMAL_ROUTER)
			expect(plan.depth).toBe(depth)
			expect(
				plan.runs.map(({ name, role, model, effort }) => ({
					name,
					role,
					model,
					effort,
				}))
			).toEqual(
				[
					{
						name: REVIEWER_NAME,
						role: 'reviewer',
						model: 'model-a',
						effort: depth === 'deep' ? 'medium' : 'low',
					},
					{
						name: REVIEWER_NAME,
						role: 'reviewer',
						model: 'model-b',
						effort: 'high',
					},
					{
						name: REVIEWER_NAME,
						role: 'reviewer',
						model: 'model-c',
						effort: 'xhigh',
					},
				].slice(0, depth === 'deep' ? cfg.models.reviewer.length : 1)
			)
		}
	)

	test.each(['reviewer', 'agents'] as const)(
		'features.%s off only disables that role',
		feature => {
			const input = planInput({
				config: config({ features: { [feature]: 'off' } }),
				agents: [agent()],
			})
			const plan = buildPlan(input, NORMAL_ROUTER)
			expect(plan.runs.map(run => run.name)).toEqual(
				feature === 'reviewer' ? ['auth'] : [REVIEWER_NAME]
			)
			expect(
				plan.skips.find(
					skip =>
						skip.name === (feature === 'reviewer' ? REVIEWER_NAME : 'auth')
				)?.reason
			).toBe(`features.${feature} is off`)
		}
	)

	for (const feature of ['reviewer', 'agents'] as const)
		for (const trigger of ['auto', 'manual'] as const)
			for (const forced of [false, true])
				test(`features.${feature} manual, trigger=${trigger}, forced=${forced}`, () => {
					const cfg = config({ features: { [feature]: 'manual' } })
					const input = planInput({
						config: cfg,
						agents: [agent()],
						pr: pr({
							trigger,
							labels: forced ? [...cfg.labels.always_review] : [],
						}),
					})
					const plan = buildPlan(input, NORMAL_ROUTER)
					const name = feature === 'reviewer' ? REVIEWER_NAME : 'auth'
					expect(plan.runs.some(run => run.name === name)).toBe(
						trigger === 'manual' || forced
					)
				})

	test.each(['off', 'manual'] as const)(
		'inactive agents with mode %s are not router candidates',
		mode => {
			const input = planInput({
				config: config({ features: { agents: mode } }),
				agents: [
					agent('billing', {
						when: { paths: ['src/billing/**'], triage: 'invoices' },
					}),
				],
			})
			expect(getPlanRouting(input)).toEqual({
				status: 'route',
				candidates: [],
				files: input.files,
			})
		}
	)

	test('whole-run gate skips routing and all planned runs', () => {
		const cfg = config()
		const [label] = DEFAULT_PRESET.skip.labels
		const input = planInput({
			config: cfg,
			agents: [agent()],
			pr: pr({ labels: [label] }),
		})
		expect(getPlanRouting(input)).toEqual({
			status: 'skip',
			router: { status: 'skipped', detail: 'run skipped', added: [] },
		})
		expect(buildPlan(input, NORMAL_ROUTER)).toMatchObject({
			skippedRun: `label ${label} is in skip.labels`,
			runs: [],
			skips: [],
			router: { status: 'skipped', detail: 'run skipped', added: [] },
			depthSource: 'run skipped',
		})
	})

	test.each([
		{ files: [] },
		{ files: [file('image.bin', { skipped: 'binary' })] },
	])(
		'no reviewable files skip routing and permit metadata agents: %p',
		({ files }) => {
			const input = planInput({
				files,
				agents: [agent('meta', { input: 'metadata' })],
			})
			const routing = getPlanRouting(input)
			expect(routing).toEqual({
				status: 'skip',
				router: { status: 'skipped', detail: 'no reviewable files', added: [] },
			})
			if (routing.status !== 'skip') return
			const plan = buildPlan(input, routing.router)
			expect(plan).toMatchObject({
				risk: 'trivial',
				riskSource: 'default',
				depth: 'quick',
				router: { status: 'skipped', detail: 'no reviewable files' },
			})
			expect(plan.runs.map(run => [run.name, run.files])).toEqual([
				['meta', []],
			])
		}
	)

	test.each(['quick', 'balanced', 'deep'] as const)(
		'fixed depth %s still requests routing for risk without candidates',
		depth => {
			const input = planInput({ config: config({ depth }) })
			expect(getPlanRouting(input)).toEqual({
				status: 'route',
				candidates: [],
				files: input.files,
			})
			expect(
				buildPlan(input, { status: 'ok', risk: 'risky', added: [] })
			).toMatchObject({
				depth,
				depthSource: 'review.yml depth',
				risk: 'risky',
				riskSource: 'router',
			})
		}
	)

	test('fixed depth still requests routing with candidates and only reviewable files', () => {
		const candidate = agent('billing', {
			when: { paths: ['src/billing/**'], triage: 'invoices' },
		})
		const reviewable = file()
		const input = planInput({
			config: config({ depth: 'balanced' }),
			agents: [candidate],
			files: [file('image.bin', { skipped: 'binary' }), reviewable],
		})
		const before = structuredClone(input)
		expect(getPlanRouting(input)).toEqual({
			status: 'route',
			candidates: [candidate],
			files: [reviewable],
		})
		const plan = buildPlan(input, NORMAL_ROUTER)
		expect(plan.files).toEqual(input.files)
		expect(plan.runs[0]?.files).toEqual([reviewable.path])
		expect(input).toEqual(before)
	})
})

describe('mechanical plan depth', () => {
	for (const rated of ['normal', 'risky'] as const)
		test(`mechanical billing edits cap ${rated} risk without forcing deep`, () => {
			const files = mechanicalFiles()
			const plan = buildPlan(
				planInput({
					files,
					config: config({ risk_paths: ['src/billing/**'] }),
				}),
				{ ...NORMAL_ROUTER, risk: rated }
			)
			expect(plan).toMatchObject({
				risk: 'normal',
				riskSource: 'mechanical',
				depth: 'balanced',
			})
			expect(plan.riskPathHits).toHaveLength(22)
			expect(plan.depthSource).not.toBe('risk_paths')
			expect(plan.runs.filter(run => run.role === 'reviewer')).toHaveLength(1)
		})
	test('mechanical edits without risk paths still cap router risk', () =>
		expect(
			buildPlan(planInput({ files: mechanicalFiles() }), {
				...NORMAL_ROUTER,
				risk: 'risky',
			})
		).toMatchObject({
			risk: 'normal',
			riskSource: 'mechanical',
			depth: 'balanced',
		}))
	test('feature changes under risk paths remain risky and deep', () =>
		expect(
			buildPlan(
				planInput({
					files: featureFiles(),
					config: config({ risk_paths: ['src/billing/**'] }),
				}),
				NORMAL_ROUTER
			)
		).toMatchObject({
			risk: 'risky',
			riskSource: 'risk_paths',
			depth: 'deep',
			depthSource: 'risk_paths',
		}))
	for (const depth of ['quick', 'deep'] as const) {
		test(`explicit ${depth} config still applies to mechanical edits`, () =>
			expect(
				buildPlan(
					planInput({
						files: mechanicalFiles(),
						config: config({ depth, risk_paths: ['src/billing/**'] }),
					}),
					NORMAL_ROUTER
				).depth
			).toBe(depth))
		test(`${depth} label still applies to mechanical edits`, () =>
			expect(
				buildPlan(
					planInput({
						files: mechanicalFiles(),
						config: config({ risk_paths: ['src/billing/**'] }),
						pr: pr({ labels: [DEFAULT_PRESET.labels.depth[depth]] }),
					}),
					NORMAL_ROUTER
				).depth
			).toBe(depth))
	}
})
