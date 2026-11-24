import { chmodSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { layer } from '@effect/vitest'
import {
	BUILT_IN_FLOOR,
	toRulesDigest,
	type KeptFinding,
} from '@mng-review/domain'
import { Effect, Layer } from 'effect'
import { GitError } from '../../../platform/git/git.errors'
import { config, finding, pr } from '../../../shared/mocks/domain-test.helper'
import { cleanupRepos } from '../../../shared/mocks/git-test.helper'
import {
	offers,
	gitFixture,
	providerError,
	reviewDependencies,
	userText,
} from '../../../shared/mocks/review-layer.helper'
import {
	answer,
	FINISH,
	finishWithUsage,
	reviewRequest,
	toolCall,
} from '../../../shared/mocks/review-test.helper'
import {
	rateRepo,
	riskRepo,
	RISK_ANSWER,
} from '../../../shared/mocks/risk-test.helper'
import {
	MAX_CORRECTIONS,
	MAX_FULL_DIFF_CHARS,
} from '../../review/domain/review.constants'
import { FloorDiffService } from './floor-diff.service'
import { RaterService, RaterServiceLive } from './rater.service'

afterEach(cleanupRepos)

layer(Layer.empty, { excludeTestServices: true })('RaterService', test => {
	test.effect(
		'excludes author text from every model message and refuses metadata and blame',
		() =>
			Effect.gen(function* () {
				const markers = [
					'TITLE_MARKER_924',
					'BODY_MARKER_925',
					'COMMIT_MARKER_926',
				]
				const repo = riskRepo()
				repo.git('commit', '--amend', '-m', markers[2] ?? '')
				const { calls, rating } = yield* rateRepo(
					{ ...repo, head: repo.git('rev-parse', 'HEAD') },
					{
						pr: pr({ title: markers[0], body: markers[1] }),
						script: (_call, index) =>
							Effect.succeed(
								index === 0
									? [
											toolCall('pr_metadata'),
											toolCall('blame', { path: 'src/value.ts', range: '1-1' }),
											toolCall('diff', { path: 'src/value.ts' }),
											FINISH,
										]
									: answer('report_risk', RISK_ANSWER)
							),
					}
				)
				expect(rating.status).toBe('rated')
				expect(calls).toHaveLength(2)
				for (const call of calls) {
					expect(offers(call, 'pr_metadata')).toBe(false)
					expect(offers(call, 'blame')).toBe(false)
					for (const marker of markers)
						expect(JSON.stringify(call.options.prompt)).not.toContain(marker)
				}
				expect(JSON.stringify(calls[1]?.options.prompt)).toContain(
					'not available'
				)
			})
	)

	for (const mode of [
		'none',
		'partial-diff',
		'all-diff',
		'all-lines',
		'partial-lines',
		'base-lines',
	] as const)
		test.effect(`a cut added file requires complete coverage: ${mode}`, () =>
			Effect.gen(function* () {
				const line = `${'x'.repeat(95)}\n`
				const lines = Math.ceil(MAX_FULL_DIFF_CHARS / line.length) + 10
				const repo = riskRepo('src/large.ts', line.repeat(lines))
				const { rating, calls } = yield* rateRepo(repo, {
					script: (call, index) => {
						if (mode === 'partial-diff' && index === 0)
							return Effect.succeed([
								toolCall('diff', { path: 'src/large.ts' }),
								FINISH,
							])
						if (mode === 'all-diff') {
							const text = JSON.stringify(call.options.prompt.content.at(-1))
							const next = /offset=(\d+)/u.exec(text)
							const offset = Number(next?.[1] ?? 0)
							if (index === 0 || next)
								return Effect.succeed([
									toolCall('diff', { path: 'src/large.ts', offset }),
									FINISH,
								])
						}
						if (
							['all-lines', 'partial-lines', 'base-lines'].includes(mode) &&
							index === 0
						) {
							const count = mode === 'partial-lines' ? lines - 1 : lines
							return Effect.succeed([
								...Array.from({ length: Math.ceil(count / 100) }, (_, part) =>
									toolCall(
										'read_file',
										{
											path: 'src/large.ts',
											ref: mode === 'base-lines' ? 'base' : 'head',
											range: `${part * 100 + 1}-${Math.min(count, (part + 1) * 100)}`,
										},
										`read-${part}`
									)
								),
								FINISH,
							])
						}
						return Effect.succeed(answer('report_risk', RISK_ANSWER))
					},
				})
				expect(userText(calls[0])).toContain('diff cut')
				expect(rating).toMatchObject(
					mode === 'all-diff' || mode === 'all-lines'
						? { status: 'rated', level: 'low' }
						: { status: 'unrated', reason: 'coverage-gap' }
				)
			})
		)

	for (const read of ['none', 'read_file', 'diff'] as const)
		test.effect(`an omitted file requires complete coverage: ${read}`, () =>
			Effect.gen(function* () {
				const repo = riskRepo()
				for (const index of Array.from({ length: 210 }, (_, value) => value))
					repo.write(
						`many/file-${String(index).padStart(3, '0')}.ts`,
						`${'x'.repeat(500)}\n`
					)
				const head = repo.commit()
				const { rating, calls } = yield* rateRepo(
					{ ...repo, head },
					{
						script: (call, index) => {
							const missing = [
								...userText(call).matchAll(
									/- ([^ ]+) \([^\n]*diff not shown\)/gu
								),
							].map(match => match[1])
							if (read === 'read_file' && index === 0)
								return Effect.succeed([
									...missing.map(path =>
										toolCall('read_file', { path, ref: 'head' }, String(path))
									),
									FINISH,
								])
							if (read === 'diff') {
								const next = /offset=(\d+)/u.exec(
									JSON.stringify(call.options.prompt.content.at(-1))
								)
								if (index === 0 || next)
									return Effect.succeed([
										toolCall('diff', { offset: Number(next?.[1] ?? 0) }),
										FINISH,
									])
							}
							return Effect.succeed(answer('report_risk', RISK_ANSWER))
						},
					}
				)
				expect(userText(calls[0])).toContain('diff not shown')
				expect(rating).toMatchObject(
					read === 'none'
						? { status: 'unrated', reason: 'coverage-gap' }
						: { status: 'rated' }
				)
			})
		)

	for (const read of ['read_file', 'diff'] as const)
		test.effect(
			`a deletion needs its whole diff, not head lines: ${read}`,
			() =>
				Effect.gen(function* () {
					const repo = riskRepo('src/large.ts', 'before\n')
					repo.write('src/large.ts', 'after\n'.repeat(22_000))
					const head = repo.commit()
					const { rating } = yield* rateRepo(
						{ ...repo, base: repo.head, head },
						{
							script: (_call, index) =>
								Effect.succeed(
									index === 0
										? [
												...(read === 'diff'
													? Array.from({ length: 10 }, (_, part) =>
															toolCall(
																'diff',
																{ path: 'src/large.ts', offset: part * 19_000 },
																`part-${part}`
															)
														)
													: Array.from({ length: 22 }, (_, part) =>
															toolCall(
																'read_file',
																{
																	path: 'src/large.ts',
																	range: `${part * 1000 + 1}-${(part + 1) * 1000}`,
																},
																`part-${part}`
															)
														)),
												FINISH,
											]
										: answer('report_risk', RISK_ANSWER)
								),
						}
					)
					expect(rating).toMatchObject(
						read === 'diff'
							? { status: 'rated' }
							: { status: 'unrated', reason: 'coverage-gap' }
					)
				})
		)

	test.effect('skip.paths files remain listed and readable by the rater', () =>
		Effect.gen(function* () {
			const repo = riskRepo('src/ignored.ts')
			const cfg = config({
				risk: { ...config().risk, enabled: true },
				skip: { paths: ['src/**'] },
			})
			const { rating, calls, change } = yield* rateRepo(repo, {
				config: cfg,
				script: (_call, index) =>
					Effect.succeed(
						index === 0
							? [
									toolCall('diff', { path: 'src/ignored.ts' }),
									toolCall('read_file', { path: 'src/ignored.ts' }),
									FINISH,
								]
							: answer('report_risk', RISK_ANSWER)
					),
			})
			expect(change.files[0]?.skipped).toBe('skip.paths')
			expect(userText(calls[0])).toContain(
				'left out of the review (skip.paths)'
			)
			expect(JSON.stringify(calls[1]?.options.prompt)).toContain('after')
			expect(JSON.stringify(calls[1]?.options.prompt)).not.toContain('error:')
			expect(rating.status).toBe('rated')
		})
	)

	for (const path of [
		'.github/workflows/check.yml',
		'.mng/check.md',
		'src/critical.ts',
	])
		test.effect(`floors raise low for ${path} and bind the rules digest`, () =>
			Effect.gen(function* () {
				const cfg = config({
					risk: {
						...config().risk,
						enabled: true,
						floors: [
							{
								name: 'critical',
								paths: ['src/critical.ts'],
								exclude: [],
								level: 'medium',
							},
						],
					},
				})
				const rules = {
					rubric: 'Consider runtime effects.',
					paths: ['docs/rubric.md'],
				}
				const { rating } = yield* rateRepo(riskRepo(path), {
					config: cfg,
					rules,
				})
				expect(rating).toMatchObject({
					status: 'rated',
					level: path.startsWith('src/') ? 'medium' : 'high',
					model: 'low',
					floor: true,
					rules: toRulesDigest(rules.rubric, cfg.risk),
				})
				expect(rating.floors).toEqual([
					expect.objectContaining({
						name: path.startsWith('.github')
							? BUILT_IN_FLOOR.GITHUB
							: path.startsWith('.mng')
								? BUILT_IN_FLOOR.MNG
								: 'critical',
						paths: [path],
						added: 1,
						deleted: 0,
					}),
				])
			})
		)

	for (const kind of ['symlink', 'mode'] as const)
		test.effect(`${kind} raises the rater's low to high`, () =>
			Effect.gen(function* () {
				const repo = riskRepo()
				if (kind === 'mode') chmodSync(join(repo.root, 'src/value.ts'), 0o755)
				else symlinkSync('value.ts', join(repo.root, 'src/link.ts'))
				const { rating } = yield* rateRepo({
					...repo,
					base: repo.head,
					head: repo.commit(),
				})
				expect(rating).toMatchObject({
					status: 'rated',
					level: 'high',
					model: 'low',
					floor: true,
				})
				expect(rating.floors).toContainEqual(
					expect.objectContaining({
						name:
							kind === 'mode' ? BUILT_IN_FLOOR.MODE : BUILT_IN_FLOOR.SYMLINK,
					})
				)
			})
		)

	for (const severity of ['high', 'critical'] as const)
		for (const confirmed of [true, false])
			test.effect(
				`${confirmed ? 'confirmed' : 'unvalidated'} ${severity} bug ${confirmed ? 'raises' : 'does not raise'} the model level`,
				() =>
					Effect.gen(function* () {
						const bug: KeptFinding = {
							...finding({ severity }),
							placement: 'inline',
							validation: confirmed
								? {
										status: 'confirmed',
										severity,
										reason: 'The write repeats.',
										evidence: [],
										model: 'validator',
									}
								: { status: 'unvalidated', error: 'No validation.' },
						}
						const { rating } = yield* rateRepo(riskRepo(), {
							review: { bugs: [bug] },
						})
						expect(rating).toMatchObject({
							status: 'rated',
							model: 'low',
							level: confirmed ? 'high' : 'low',
						})
					})
			)

	test.effect(
		'router risky raises low to medium while preserving model low',
		() =>
			Effect.gen(function* () {
				const { rating } = yield* rateRepo(riskRepo(), {
					router: { status: 'ok', risk: 'risky', added: [] },
				})
				expect(rating).toMatchObject({
					status: 'rated',
					level: 'medium',
					model: 'low',
				})
			})
	)

	for (const gap of ['endpointError', 'incomplete'] as const)
		test.effect(`${gap} is unrated without a rater call`, () =>
			Effect.gen(function* () {
				const { rating, calls } = yield* rateRepo(riskRepo(), {
					review:
						gap === 'endpointError'
							? { endpointError: 'Finder failed.' }
							: {
									incomplete: {
										reason: 'Budget exhausted.',
										unfinished: ['reviewer'],
									},
								},
				})
				expect(rating).toMatchObject({
					status: 'unrated',
					reason: gap === 'endpointError' ? 'run-failed' : 'budget-stopped',
				})
				expect(calls).toEqual([])
			})
		)

	for (const status of ['failed', 'incomplete'] as const)
		test.effect(
			`a finder that ${status === 'failed' ? 'failed' : 'only partly ran'} without a run-level marker is unrated without a rater call`,
			() =>
				Effect.gen(function* () {
					const { rating, calls } = yield* rateRepo(riskRepo(), {
						review: {
							agents: [
								{
									name: 'reviewer',
									title: 'Main reviewer',
									kind: 'bug',
									model: 'model-a',
									effort: 'high',
									status,
									error: 'agent gave no valid report_findings answer',
									toolCalls: 0,
									findings: 0,
									malformed: 0,
									wallMillis: 0,
								},
							],
						},
					})
					expect(rating).toMatchObject({
						status: 'unrated',
						reason: status === 'failed' ? 'run-failed' : 'budget-stopped',
					})
					expect(calls).toEqual([])
				})
		)

	for (const forced of [true, false])
		test.effect(
			`an answer ${forced ? 'the token budget forced is unrated' : 'under the token budget is rated'}`,
			() =>
				Effect.gen(function* () {
					const { rating, calls } = yield* rateRepo(riskRepo(), {
						script: (_call, index) =>
							Effect.succeed(
								index === 0
									? [
											toolCall('read_file', { path: 'src/value.ts' }),
											finishWithUsage(forced ? 200_000 : 10),
										]
									: answer('report_risk', RISK_ANSWER)
							),
					})
					expect(calls).toHaveLength(2)
					expect(rating).toMatchObject(
						forced
							? { status: 'unrated', reason: 'budget-stopped' }
							: { status: 'rated', level: 'low' }
					)
				})
		)

	for (const extension of ['bin', 'png'])
		test.effect(
			`${extension} binary ${extension === 'png' ? 'is an asset' : 'prevents rating without a model call'}`,
			() =>
				Effect.gen(function* () {
					const repo = riskRepo()
					repo.write(`data.${extension}`, new Uint8Array([0, 1, 2, 3]))
					const { rating, calls } = yield* rateRepo({
						...repo,
						head: repo.commit(),
					})
					expect(rating).toMatchObject(
						extension === 'png'
							? { status: 'rated' }
							: { status: 'unrated', reason: 'opaque-binary' }
					)
					expect(calls).toHaveLength(extension === 'png' ? 1 : 0)
				})
		)

	for (const malformed of [
		{ reasons: ['Reason'], refs: [] },
		{ level: 'unknown', reasons: ['Reason'], refs: [] },
		{ level: 'low', reasons: [' ', '\n'], refs: [] },
		['low'],
	])
		test.effect(
			`malformed answer ${JSON.stringify(malformed)} exhausts corrections and never defaults to low`,
			() =>
				Effect.gen(function* () {
					const { rating, calls } = yield* rateRepo(riskRepo(), {
						script: () => Effect.succeed(answer('report_risk', malformed)),
					})
					expect(rating).toMatchObject({
						status: 'unrated',
						reason: 'rater-failed',
					})
					expect(calls).toHaveLength(MAX_CORRECTIONS + 1)
				})
		)

	for (const available of [true, false])
		test.effect(
			`a dropped model ${available ? 'moves to the next model' : 'leaves the run unrated when no choice remains'}`,
			() =>
				Effect.gen(function* () {
					const cfg = config({
						risk: { ...config().risk, enabled: true },
						models: {
							reviewer: [
								{ model: 'first', effort: 'high' },
								{ model: 'second', effort: 'high' },
							],
							validator: 'cross',
						},
					})
					const { rating, calls } = yield* rateRepo(riskRepo(), {
						config: cfg,
						script: call =>
							call.model.model === 'first' || !available
								? Effect.fail(providerError(503))
								: Effect.succeed(answer('report_risk', RISK_ANSWER)),
					})
					expect(calls.map(call => call.model.model)).toEqual([
						'first',
						'second',
					])
					expect(rating).toMatchObject(
						available
							? { status: 'rated', rater: 'second' }
							: { status: 'unrated', reason: 'rater-failed' }
					)
				})
		)

	test.effect(
		'a floor-diff git failure returns run-failed without a model call',
		() =>
			Effect.gen(function* () {
				const request = reviewRequest()
				const scriptSpy = vi.fn(() =>
					Effect.succeed(answer('report_risk', RISK_ANSWER))
				)
				const services = RaterServiceLive.pipe(
					Layer.provide(
						Layer.succeed(FloorDiffService, {
							read: () =>
								Effect.fail(
									new GitError({
										args: ['diff'],
										exitCode: 128,
										stderr: 'missing object',
									})
								),
						})
					),
					Layer.provide(reviewDependencies(scriptSpy))
				)
				const rating = yield* RaterService.use(service =>
					service.rate({
						rules: request.rules,
						change: request.planReport.change,
						pr: request.pr,
						plan: request.planReport.plan,
						review: { bugs: [], nits: [], rejected: [], agents: [] },
					})
				).pipe(Effect.provide(services))
				expect(rating).toMatchObject({
					status: 'unrated',
					reason: 'run-failed',
				})
				if (rating.status === 'unrated')
					expect(rating.detail).toContain('missing object')
				expect(scriptSpy).not.toHaveBeenCalled()
			})
	)
	test.effect(
		'a git failure while reading the rater diff returns run-failed',
		() =>
			Effect.gen(function* () {
				const request = reviewRequest()
				const scriptSpy = vi.fn(() =>
					Effect.succeed(answer('report_risk', RISK_ANSWER))
				)
				const services = RaterServiceLive.pipe(
					Layer.provide(
						Layer.succeed(FloorDiffService, {
							read: () => Effect.succeed({ intact: true, files: [] }),
						})
					),
					Layer.provide(
						reviewDependencies(
							scriptSpy,
							{},
							gitFixture({
								readDiff: () =>
									Effect.fail(
										new GitError({
											args: ['diff'],
											exitCode: 128,
											stderr: 'missing diff object',
										})
									),
							})
						)
					)
				)
				const rating = yield* RaterService.use(service =>
					service.rate({
						rules: request.rules,
						change: request.planReport.change,
						pr: request.pr,
						plan: request.planReport.plan,
						review: { bugs: [], nits: [], rejected: [], agents: [] },
					})
				).pipe(Effect.provide(services))
				expect(scriptSpy).not.toHaveBeenCalled()
				expect(rating).toMatchObject({
					status: 'unrated',
					reason: 'run-failed',
				})
			})
	)
})
