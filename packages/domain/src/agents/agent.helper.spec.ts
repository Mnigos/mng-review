import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { ConfigError } from '../config/config.errors'
import { agent, config } from '../shared/mocks/domain-test.helper'
import { parseAgentFile } from './agent-file.parser'
import { AGENT_KINDS } from './agent.constants'
import { getAgentSettings, raiseEffort, toDeclaredAgent } from './agent.helper'

layer(Layer.empty)('toDeclaredAgent', test => {
	test.effect('trims expanded instructions and omits the unexpanded body', () =>
		Effect.gen(function* () {
			const agentFile = yield* parseAgentFile(
				'auth',
				'---\nkind: bug\n---\n@/docs/auth.md'
			)
			const declared = yield* toDeclaredAgent(
				agentFile,
				' \nCheck ownership.\n '
			)
			expect(declared).toEqual({
				name: agentFile.name,
				title: agentFile.title,
				file: agentFile.file,
				frontMatter: agentFile.frontMatter,
				instructions: 'Check ownership.',
			})
			expect(declared).not.toHaveProperty('body')
			expect(agentFile.body).toBe('@/docs/auth.md')
		})
	)

	for (const [body, expanded] of [
		['', ''],
		[' \n\t', ' \n\t'],
		['@/empty.md', ''],
	] as const)
		test.effect(
			`rejects empty expanded instructions from ${JSON.stringify(body)}`,
			() =>
				Effect.gen(function* () {
					const agentFile = yield* parseAgentFile(
						'auth',
						`---\nkind: bug\n---\n${body}`
					)
					const error = yield* Effect.flip(toDeclaredAgent(agentFile, expanded))
					expect(error).toBeInstanceOf(ConfigError)
					expect(error.source).toBe(agentFile.file)
					expect(error.reason).toContain('no instructions')
				})
		)
})

describe('getAgentSettings', () => {
	for (const kind of AGENT_KINDS) {
		test(`${kind} inherits agent model and effort`, () => {
			const cfg = config({
				models: { agents: { model: 'test-agent', effort: 'low' } },
			})
			expect(getAgentSettings(agent('check', { kind }), cfg)).toEqual({
				model: 'test-agent',
				effort: 'low',
				comments: cfg.comments,
			})
		})
		test(`${kind} overrides model, effort and individual comment settings`, () => {
			const cfg = config()
			const before = structuredClone(cfg)
			expect(
				getAgentSettings(
					agent('auth', {
						kind,
						model: 'custom',
						effort: 'low',
						comments: { max_nits: 2, summary: false },
					}),
					cfg
				)
			).toEqual({
				model: 'custom',
				effort: 'low',
				comments: { ...cfg.comments, max_nits: 2, summary: false },
			})
			expect(cfg).toEqual(before)
		})
		test(`${kind} model and effort overrides are independent`, () => {
			const cfg = config({
				models: { agents: { model: 'test-agent', effort: 'medium' } },
			})
			expect(
				getAgentSettings(agent('check', { kind, model: 'custom' }), cfg)
			).toEqual({ model: 'custom', effort: 'medium', comments: cfg.comments })
			expect(
				getAgentSettings(agent('check', { kind, effort: 'low' }), cfg)
			).toEqual({ model: 'test-agent', effort: 'low', comments: cfg.comments })
		})
	}
})

test.each([
	['minimal', 'low'],
	['low', 'medium'],
	['medium', 'high'],
	['high', 'high'],
	['xhigh', 'xhigh'],
] as const)('raises %s to %s without lowering xhigh', (input, expected) => {
	expect(raiseEffort(input)).toBe(expected)
})
