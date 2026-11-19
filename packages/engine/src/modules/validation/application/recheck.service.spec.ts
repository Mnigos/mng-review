import { layer } from '@effect/vitest'
import { ConfigProvider, Effect, Layer } from 'effect'
import { HttpClient } from 'effect/http'
import type { ScriptedLlmCall } from '../../../platform/llm/scripted-llm.layer'
import { TokenLedgerLive } from '../../../platform/llm/token-ledger.service'
import { config, finding, pr } from '../../../shared/mocks/domain-test.helper'
import {
	cleanupRepos,
	createRepo,
	gitLayer,
} from '../../../shared/mocks/git-test.helper'
import { recheckLayer } from '../../../shared/mocks/recheck-layer.helper'
import { userText } from '../../../shared/mocks/review-layer.helper'
import { answer, verdict } from '../../../shared/mocks/review-test.helper'
import { makeValidatorLayer } from '../infrastructure/validation.layers'
import { RecheckService, RecheckServiceLive } from './recheck.service'

vi.mock('../infrastructure/validation.layers', async importOriginal => {
	const actual =
		await importOriginal<typeof import('../infrastructure/validation.layers')>()
	return { ...actual, makeValidatorLayer: vi.fn(actual.makeValidatorLayer) }
})

/** Three commits let each earlier finding have its own base and diff. */
function setup() {
	const repo = createRepo()
	repo.write('src/store.ts', 'first\n')
	const base = repo.commit()
	repo.write('src/store.ts', 'second\n')
	const middle = repo.commit()
	repo.write('src/store.ts', 'third\n')
	const head = repo.commit()
	const rules = {
		config: config({
			models: { validator: { model: 'validator', effort: 'high' } },
		}),
		agents: [],
		source: base,
	}
	const services = RecheckServiceLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				gitLayer(repo.root),
				TokenLedgerLive,
				Layer.succeed(
					HttpClient.HttpClient,
					HttpClient.make(() => Effect.die('network must not run'))
				)
			)
		)
	)
	return { repo, base, middle, head, rules, services }
}

afterEach(() => {
	cleanupRepos()
	vi.mocked(makeValidatorLayer).mockReset()
})

layer(Layer.empty, { excludeTestServices: true })('RecheckService', test => {
	test.effect(
		'validates each item over its own base to head and preserves finding identity and order',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				const first = finding({
					path: 'src/store.ts',
					line: 1,
					title: 'First problem',
				})
				const second = finding({
					path: 'src/store.ts',
					line: 1,
					title: 'Second problem',
				})
				const scriptSpy = vi.fn((_call: ScriptedLlmCall) =>
					Effect.succeed(
						answer(
							'report_verdict',
							verdict({
								verdict: 'reject',
								reason: 'The head prevents it.',
								evidence: ['src/store.ts:1 third'],
							})
						)
					)
				)
				vi.mocked(makeValidatorLayer).mockImplementation(limits =>
					recheckLayer(scriptSpy, limits)
				)
				const checked = yield* RecheckService.use(service =>
					service.recheck({
						rules: fixture.rules,
						headRef: fixture.head,
						pr: pr(),
						items: [
							{ finding: first, base: fixture.base },
							{ finding: second, base: fixture.middle },
						],
					})
				).pipe(Effect.provide(fixture.services))
				expect(checked.results.map(entry => entry.finding)).toEqual([
					first,
					second,
				])
				expect(checked.results[0]?.finding).toBe(first)
				expect(checked.results[1]?.finding).toBe(second)
				expect(checked.results.map(entry => entry.validation.status)).toEqual([
					'rejected',
					'rejected',
				])
				expect(scriptSpy).toHaveBeenCalledTimes(2)
				const messages = scriptSpy.mock.calls.map(([call]) => userText(call))
				expect(messages.find(text => text.includes('First problem'))).toContain(
					'-first'
				)
				expect(
					messages.find(text => text.includes('Second problem'))
				).toContain('-second')
				expect(messages.every(text => text.includes('+third'))).toBe(true)
				expect(checked.tokens.validator?.calls).toBe(2)
			})
	)
	test.effect(
		'an unreadable item base is omitted while a readable item is still checked',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				const scriptSpy = vi.fn((_call: ScriptedLlmCall) =>
					Effect.succeed(
						answer(
							'report_verdict',
							verdict({
								verdict: 'reject',
								reason: 'Fixed.',
								evidence: ['src/store.ts:1 third'],
							})
						)
					)
				)
				vi.mocked(makeValidatorLayer).mockImplementation(limits =>
					recheckLayer(scriptSpy, limits)
				)
				const kept = finding({ path: 'src/store.ts', line: 1 })
				const checked = yield* RecheckService.use(service =>
					service.recheck({
						rules: fixture.rules,
						headRef: fixture.head,
						pr: pr(),
						items: [
							{ finding: finding(), base: 'missing-commit' },
							{ finding: kept, base: fixture.base },
						],
					})
				).pipe(Effect.provide(fixture.services))
				expect(checked.results).toHaveLength(1)
				expect(checked.results[0]?.finding).toBe(kept)
				expect(scriptSpy).toHaveBeenCalledTimes(1)
			})
	)
	test.effect('empty input never builds a validator or calls a model', () =>
		Effect.gen(function* () {
			const fixture = setup()
			expect(
				yield* RecheckService.use(service =>
					service.recheck({
						rules: fixture.rules,
						headRef: fixture.head,
						pr: pr(),
						items: [],
					})
				).pipe(Effect.provide(fixture.services))
			).toEqual({ results: [], tokens: {} })
			expect(makeValidatorLayer).not.toHaveBeenCalled()
		})
	)
	test.effect(
		'missing endpoint configuration returns no results without HTTP',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				const actual = yield* Effect.promise(
					async () =>
						await vi.importActual<
							typeof import('../infrastructure/validation.layers')
						>('../infrastructure/validation.layers')
				)
				vi.mocked(makeValidatorLayer).mockImplementation(
					actual.makeValidatorLayer
				)
				expect(
					yield* RecheckService.use(service =>
						service.recheck({
							rules: fixture.rules,
							headRef: fixture.head,
							pr: pr(),
							items: [{ finding: finding(), base: fixture.base }],
						})
					).pipe(
						Effect.provide(fixture.services),
						Effect.provide(
							ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))
						)
					)
				).toEqual({ results: [], tokens: {} })
			})
	)
	test.effect.fails(
		'a known base on a diverged branch must use that commit in the validator diff',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.repo.git('checkout', '-b', 'old-review', fixture.middle)
				fixture.repo.write('src/store.ts', 'side-branch bug\n')
				const oldHead = fixture.repo.commit()
				fixture.repo.git('checkout', 'main')
				const scriptSpy = vi.fn((_call: ScriptedLlmCall) =>
					Effect.succeed(
						answer(
							'report_verdict',
							verdict({
								verdict: 'reject',
								reason: 'Fixed.',
								evidence: ['src/store.ts:1 third'],
							})
						)
					)
				)
				vi.mocked(makeValidatorLayer).mockImplementation(limits =>
					recheckLayer(scriptSpy, limits)
				)
				const checked = yield* RecheckService.use(service =>
					service.recheck({
						rules: fixture.rules,
						headRef: fixture.head,
						pr: pr(),
						items: [
							{
								finding: finding({ path: 'src/store.ts', line: 1 }),
								base: oldHead,
							},
						],
					})
				).pipe(Effect.provide(fixture.services))
				expect(checked.results).toHaveLength(1)
				expect(scriptSpy).toHaveBeenCalledTimes(1)
				expect(userText(scriptSpy.mock.calls[0]?.[0])).toContain(
					'-side-branch bug'
				)
			})
	)
})
