import type { RiskSignal } from '../routing.types'
import {
	getFocusPaths,
	getKnownSignals,
	getRouterRisk,
} from './router-risk.helper'

const SIGNAL = {
	category: 'access',
	path: 'src/auth/session.guard.ts',
	reason: 'Lines 8-12 change who may update a session.',
} as const satisfies RiskSignal

describe('getKnownSignals', () => {
	test.each(['./a/b.ts', 'a//b.ts', 'a/./b.ts', 'a/c/../b.ts'])(
		'normalises %s and trims the reason on a changed file',
		path => {
			expect(
				getKnownSignals(
					[{ ...SIGNAL, path, reason: '  changes access \n' }],
					['a/b.ts']
				)
			).toEqual([
				{ category: SIGNAL.category, path: 'a/b.ts', reason: 'changes access' },
			])
		}
	)
	test.each(['src/unchanged.ts', '../a/b.ts', '/a/b.ts', 'a\\b.ts'])(
		'drops a signal outside the reviewable change: %s',
		path => {
			expect(getKnownSignals([{ ...SIGNAL, path }], ['a/b.ts'])).toEqual([])
		}
	)
	test.each(['', ' \n\t '])('drops a blank reason %j', reason => {
		expect(getKnownSignals([{ ...SIGNAL, reason }], [SIGNAL.path])).toEqual([])
	})
	test('keeps the first valid signal once per normalised category and path', () => {
		expect(
			getKnownSignals(
				[
					{ ...SIGNAL, reason: '  ' },
					{ ...SIGNAL, path: `./${SIGNAL.path}` },
					{ ...SIGNAL, reason: 'A second explanation.' },
				],
				[SIGNAL.path]
			)
		).toEqual([SIGNAL])
	})
	test('keeps different categories on one path and one category on different paths', () => {
		const signals = [
			SIGNAL,
			{ ...SIGNAL, category: 'secrets' },
			{ ...SIGNAL, path: 'src/auth/role.guard.ts' },
		] as const satisfies readonly RiskSignal[]
		expect(
			getKnownSignals(
				signals,
				signals.map(signal => signal.path)
			)
		).toEqual(signals)
	})
	test('has no signals without reviewable changed paths', () => {
		expect(getKnownSignals([SIGNAL], [])).toEqual([])
	})
})

describe('getRouterRisk', () => {
	test.each([false, true])('a valid signal wins over trivial=%s', trivial => {
		expect(getRouterRisk([SIGNAL], trivial)).toBe('risky')
	})
	test('no signals and no trivial flag means normal', () => {
		expect(getRouterRisk([], false)).toBe('normal')
	})
	test('no signals and a trivial flag means trivial', () => {
		expect(getRouterRisk([], true)).toBe('trivial')
	})
	test('discarded signals cannot make a trivial change risky', () => {
		expect(getRouterRisk(getKnownSignals([SIGNAL], []), true)).toBe('trivial')
	})
})

describe('getFocusPaths', () => {
	test('risk path hits take precedence over router signals', () => {
		expect(
			getFocusPaths({
				riskPathHits: ['src/data/migration.ts'],
				riskSource: 'router',
				router: { status: 'ok', added: [], signals: [SIGNAL] },
			})
		).toEqual(['src/data/migration.ts'])
	})
	test('router risk focuses on unique signal paths in signal order', () => {
		expect(
			getFocusPaths({
				riskPathHits: [],
				riskSource: 'router',
				router: {
					status: 'ok',
					added: [],
					signals: [
						SIGNAL,
						{ ...SIGNAL, category: 'secrets' },
						{ ...SIGNAL, path: 'src/auth/role.guard.ts' },
					],
				},
			})
		).toEqual([SIGNAL.path, 'src/auth/role.guard.ts'])
	})
	test.each(['default', 'mechanical', 'risk_paths'] as const)(
		'%s risk without path hits does not focus on router signals',
		riskSource => {
			expect(
				getFocusPaths({
					riskPathHits: [],
					riskSource,
					router: { status: 'ok', added: [], signals: [SIGNAL] },
				})
			).toEqual([])
		}
	)
	test('a router report without signals leaves the review unrestricted', () => {
		expect(
			getFocusPaths({
				riskPathHits: [],
				riskSource: 'router',
				router: { status: 'ok', added: [] },
			})
		).toEqual([])
	})
})
