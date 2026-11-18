import { agent, config, finding } from '../shared/mocks/domain-test.helper'
import {
	getSeverityFloor,
	hasBlockingBug,
	placeNits,
} from './finding-placement.helper'
import { isAtLeast } from './finding.helper'

describe('getSeverityFloor', () => {
	test('global floor excludes low bugs and includes bugs equal to the floor', () => {
		const cfg = config()
		expect(getSeverityFloor(finding(), cfg, new Map())).toBe(
			cfg.comments.min_severity
		)
		expect(isAtLeast('low', getSeverityFloor(finding(), cfg, new Map()))).toBe(
			false
		)
		expect(
			isAtLeast(
				cfg.comments.min_severity,
				getSeverityFloor(finding(), cfg, new Map())
			)
		).toBeTruthy()
	})
	test('uses an agent override instead of the global floor', () => {
		const agents = new Map([
			['strict', agent('strict', { comments: { min_severity: 'high' } })],
		])
		expect(
			getSeverityFloor(finding({ agents: ['strict'] }), config(), agents)
		).toBe('high')
	})
	test('merged findings use the lowest floor among all reporters', () => {
		const agents = new Map([
			['strict', agent('strict', { comments: { min_severity: 'critical' } })],
			['lenient', agent('lenient', { comments: { min_severity: 'low' } })],
		])
		expect(
			getSeverityFloor(
				finding({ agents: ['strict', 'lenient'] }),
				config(),
				agents
			)
		).toBe('low')
		expect(
			getSeverityFloor(
				finding({ agents: ['strict', 'reviewer'] }),
				config(),
				agents
			)
		).toBe(config().comments.min_severity)
		expect(
			getSeverityFloor(
				finding({ agents: ['strict', 'unknown'] }),
				config(),
				agents
			)
		).toBe(config().comments.min_severity)
		expect(getSeverityFloor(finding({ agents: [] }), config(), agents)).toBe(
			config().comments.min_severity
		)
	})
})

describe('placeNits', () => {
	test('global and agent caps keep the most severe nits inline without mutating input', () => {
		const agents = new Map([
			['style', agent('style', { kind: 'nit', comments: { max_nits: 1 } })],
		])
		const cfg = config({ comments: { max_nits: 2 } })
		const nits = [
			finding({ kind: 'nit', severity: 'low', agents: ['style'], line: 1 }),
			finding({
				kind: 'nit',
				severity: 'critical',
				agents: ['style'],
				line: 2,
			}),
			finding({ kind: 'nit', severity: 'medium', agents: ['other'], line: 3 }),
			finding({ kind: 'nit', severity: 'low', agents: ['other'], line: 4 }),
		]
		const before = structuredClone({ nits, cfg, agents })
		expect(
			placeNits(nits, cfg, agents).map(nit => [nit.line, nit.placement])
		).toEqual([
			[2, 'inline'],
			[3, 'inline'],
			[1, 'summary'],
			[4, 'summary'],
		])
		expect({ nits, cfg, agents }).toEqual(before)
	})
	test('zero global or agent cap puts every nit in the summary', () => {
		const nit = finding({ kind: 'nit', agents: ['style'] })
		expect(
			placeNits([nit], config({ comments: { max_nits: 0 } }), new Map())[0]
				?.placement
		).toBe('summary')
		const agents = new Map([
			['style', agent('style', { kind: 'nit', comments: { max_nits: 0 } })],
		])
		expect(placeNits([nit], config(), agents)[0]?.placement).toBe('summary')
	})
	test('counts a merged nit against its first reporter and permits unknown or absent reporters', () => {
		const agents = new Map([
			['style', agent('style', { kind: 'nit', comments: { max_nits: 0 } })],
		])
		const nits = [
			finding({ kind: 'nit', agents: ['unknown', 'style'], line: 1 }),
			finding({ kind: 'nit', agents: [], line: 2 }),
			finding({ kind: 'nit', agents: ['style', 'unknown'], line: 3 }),
		]
		expect(placeNits(nits, config(), agents).map(nit => nit.placement)).toEqual(
			['inline', 'inline', 'summary']
		)
		expect(placeNits([], config(), agents)).toEqual([])
	})
})

test('only inline kept bugs block, including a later inline bug in the list', () => {
	expect(hasBlockingBug([])).toBe(false)
	expect(hasBlockingBug([{ placement: 'summary' }])).toBe(false)
	expect(
		hasBlockingBug([{ placement: 'summary' }, { placement: 'inline' }])
	).toBeTruthy()
})
