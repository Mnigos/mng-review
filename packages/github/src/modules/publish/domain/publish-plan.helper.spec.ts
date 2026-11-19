import { NEAR_LINES, SAME_TITLE_OVERLAP } from '@mng-review/domain'
import { agent, config } from '../../../shared/mocks/domain-test.helper'
import {
	botThread,
	bug,
	RULES,
} from '../../../shared/mocks/publish-test.helper'
import type { ThreadKind } from './publish-marker.schema'
import {
	countOpenBugs,
	getMatchingThreads,
	getPublishedFindings,
	planPublish,
	type PublishSelection,
} from './publish-plan.helper'
import type { BotThread } from './publish.types'

/** Only the finding under examination is selected. */
function selection(): PublishSelection {
	return {
		outcome: { bugs: [bug()], nits: [], rejected: [] },
		config: RULES.config,
		agents: new Map(),
	}
}

describe('getPublishedFindings', () => {
	test.each(['low', 'medium', 'high', 'critical'] as const)(
		'publishes unverified bugs exactly at the %s floor',
		severity => {
			const finding = bug({
				severity,
				placement: 'summary',
				validation: {
					status: 'unverified',
					severity,
					reason: 'No contract',
					premise: 'Dependency behavior',
					evidence: [],
					model: 'validator',
				},
			})
			expect(
				getPublishedFindings({
					...selection(),
					config: config({ comments: { min_severity: severity } }),
					outcome: { ...selection().outcome, bugs: [finding] },
				})
			).toEqual([{ finding, kind: 'unverified' }])
		}
	)

	test('selects inline bugs, above-floor unverified bugs and inline nits only', () => {
		const unverified = bug({
			placement: 'summary',
			validation: {
				status: 'unverified',
				severity: 'high',
				reason: 'Missing dependency evidence',
				premise: 'Callback behavior',
				evidence: [],
				model: 'validator',
			},
		})
		const outcome = {
			...selection().outcome,
			bugs: [
				bug(),
				bug({ placement: 'summary' }),
				unverified,
				{ ...unverified, severity: 'low' as const },
			],
			nits: [bug({ kind: 'nit' }), bug({ kind: 'nit', placement: 'summary' })],
		}
		expect(
			getPublishedFindings({ ...selection(), outcome }).map(entry => entry.kind)
		).toEqual(['bug', 'unverified', 'nit'])
	})
	test('uses the reporting agent severity floor', () => {
		const finding = bug({
			agents: ['specialist'],
			severity: 'medium',
			placement: 'summary',
			validation: {
				status: 'unverified',
				severity: 'medium',
				reason: 'Unknown',
				premise: 'Dependency behavior',
				evidence: [],
				model: 'validator',
			},
		})
		expect(
			getPublishedFindings({
				...selection(),
				config: config(),
				agents: new Map([
					[
						'specialist',
						agent('specialist', { comments: { min_severity: 'high' } }),
					],
				]),
				outcome: { ...selection().outcome, bugs: [finding] },
			})
		).toEqual([])
	})
})

describe('getMatchingThreads', () => {
	for (const kind of ['bug', 'unverified', 'nit'] as const)
		for (const existing of ['bug', 'unverified', 'nit'] as const)
			test(`${existing} thread coverage of ${kind}`, () => {
				const thread = botThread()
				const allowed =
					kind === existing || (kind === 'unverified' && existing === 'bug')
				expect(
					getMatchingThreads({ finding: bug(), kind }, [
						{ ...thread, marker: { ...thread.marker, kind: existing } },
					])
				).toHaveLength(allowed ? 1 : 0)
			})
	test('fingerprint matches independently of path, line and title, including file threads', () => {
		expect(
			getMatchingThreads({ finding: bug(), kind: 'bug' }, [
				botThread({ path: 'other.ts', line: 999, onFile: true }),
			])
		).toHaveLength(1)
	})
	test('nearby line uses original line when current line is absent', () => {
		const thread = botThread()
		expect(
			getMatchingThreads({ finding: bug(), kind: 'bug' }, [
				{
					...thread,
					line: undefined,
					originalLine: bug().line + NEAR_LINES,
					marker: { ...thread.marker, fingerprint: 'different' },
				},
			])
		).toHaveLength(1)
	})
	test.each([
		{
			path: 'src/store.ts',
			distance: NEAR_LINES,
			onFile: false,
			title: 'Duplicate write loses data',
			matches: true,
		},
		{
			path: 'src/store.ts',
			distance: NEAR_LINES + 1,
			onFile: false,
			title: 'Duplicate write loses data',
			matches: false,
		},
		{
			path: 'other.ts',
			distance: 0,
			onFile: false,
			title: 'Duplicate write loses data',
			matches: false,
		},
		{
			path: 'src/store.ts',
			distance: 0,
			onFile: true,
			title: 'Duplicate write loses data',
			matches: false,
		},
		{
			path: 'src/store.ts',
			distance: 0,
			onFile: false,
			title: 'Unrelated parser crashes',
			matches: false,
		},
	])('matches nearby titles $path $distance $onFile $title', row => {
		const thread = botThread({
			path: row.path,
			line: bug().line + row.distance,
			onFile: row.onFile,
		})
		expect(
			getMatchingThreads({ finding: bug(), kind: 'bug' }, [
				{
					...thread,
					marker: {
						...thread.marker,
						fingerprint: 'different',
						title: row.title,
					},
				},
			])
		).toHaveLength(row.matches ? 1 : 0)
	})
	test('compares title Jaccard at the exported threshold', () => {
		const words = [
			'alpha',
			'bravo',
			'charlie',
			'delta',
			'echo',
			'foxtrot',
			'golf',
			'hotel',
			'india',
			'juliet',
		]
		for (const shared of [
			Math.ceil(words.length * SAME_TITLE_OVERLAP) - 1,
			Math.ceil(words.length * SAME_TITLE_OVERLAP),
		]) {
			const thread = botThread()
			expect(
				getMatchingThreads(
					{ finding: bug({ title: words.join(' ') }), kind: 'bug' },
					[
						{
							...thread,
							marker: {
								...thread.marker,
								fingerprint: 'other',
								title: words.slice(0, shared).join(' '),
							},
						},
					]
				)
			).toHaveLength(shared / words.length >= SAME_TITLE_OVERLAP ? 1 : 0)
		}
	})
})

describe('planPublish', () => {
	test.each([
		{
			label: 'open even if changed',
			resolved: false,
			changed: ['a', 'b'],
			repeated: 1,
		},
		{ label: 'resolved unchanged', resolved: true, changed: [], repeated: 1 },
		{
			label: 'one resolved unchanged',
			resolved: true,
			changed: ['a'],
			repeated: 1,
		},
		{
			label: 'every resolved changed',
			resolved: true,
			changed: ['a', 'b'],
			repeated: 0,
		},
	])('$label', row => {
		const threads = ['a', 'b'].map(id =>
			botThread({ id, resolved: row.resolved })
		)
		const plan = planPublish(selection(), {
			threads,
			lines: new Map(),
			changedPlaces: new Set(row.changed),
		})
		expect(plan.repeated).toHaveLength(row.repeated)
		expect(plan.threads).toHaveLength(1 - row.repeated)
	})
	test.each([
		{ lines: new Map([['src/store.ts', new Set([10])]]), place: 'line' },
		{ lines: new Map([['src/store.ts', new Set([100])]]), place: 'file' },
		{ lines: new Map(), place: 'summary' },
	])('chooses $place placement', row => {
		expect(
			planPublish(selection(), {
				threads: [],
				lines: row.lines,
				changedPlaces: new Set(),
			}).threads[0]?.place
		).toBe(row.place)
	})
	test('counts unresolved bugs and new bugs regardless of placement, excluding nits and unverified', () => {
		const threads: BotThread[] = (
			['bug', 'unverified', 'nit'] satisfies ThreadKind[]
		).flatMap(kind =>
			[false, true].map(resolved => {
				const thread = botThread({ resolved })
				return { ...thread, marker: { ...thread.marker, kind } }
			})
		)
		expect(
			countOpenBugs(
				{
					threads: [
						{ finding: bug(), kind: 'bug', place: 'summary' },
						{ finding: bug(), kind: 'unverified', place: 'line' },
						{ finding: bug(), kind: 'nit', place: 'file' },
					],
					repeated: [],
					summaryNits: [],
				},
				threads
			)
		).toBe(2)
	})
})
