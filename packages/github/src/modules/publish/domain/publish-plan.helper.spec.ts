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
	isPullRequestFinding,
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
	test.each([false, true])(
		'outdated thread matches only by fingerprint: same=%s',
		sameFingerprint => {
			const thread = botThread()
			expect(
				getMatchingThreads({ finding: bug(), kind: 'bug' }, [
					{
						...thread,
						line: undefined,
						originalLine: bug().line + NEAR_LINES,
						marker: {
							...thread.marker,
							fingerprint: sameFingerprint ? bug().fingerprint : 'different',
						},
					},
				])
			).toHaveLength(sameFingerprint ? 1 : 0)
		}
	)
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

describe('isPullRequestFinding', () => {
	test.each([
		{ names: ['metadata'], expected: true },
		{ names: ['metadata', 'other-metadata'], expected: true },
		{ names: ['metadata', 'diff'], expected: false },
		{ names: ['metadata', 'full-diff'], expected: false },
		{ names: ['reviewer'], expected: false },
		{ names: ['metadata', 'reviewer'], expected: false },
		{ names: ['unknown'], expected: false },
		{ names: ['metadata', 'unknown'], expected: false },
		{ names: [], expected: false },
	])(
		'classifies reporting agents $names as $expected',
		({ names, expected }) => {
			expect(
				isPullRequestFinding(
					{ agents: names },
					new Map([
						['metadata', agent('metadata', { input: 'metadata' })],
						['other-metadata', agent('other-metadata', { input: 'metadata' })],
						['diff', agent('diff', { input: 'incremental' })],
						['full-diff', agent('full-diff', { input: 'full_diff' })],
					])
				)
			).toBe(expected)
		}
	)
})

describe('planPublish', () => {
	for (const kind of ['bug', 'unverified', 'nit'] as const)
		for (const location of ['line', 'file', 'outside'] as const)
			test(`places a metadata ${kind} in the pull request summary when its location is ${location}`, () => {
				const finding = bug({
					agents: ['metadata'],
					kind: kind === 'nit' ? 'nit' : 'bug',
					severity: 'medium',
					placement: kind === 'unverified' ? 'summary' : 'inline',
					...(kind === 'unverified'
						? ({
								validation: {
									status: 'unverified',
									severity: 'medium',
									premise: 'Pull request scope',
									reason: 'Missing supporting description',
									evidence: [],
									model: 'validator',
								},
							} as const)
						: {}),
				})
				const plan = planPublish(
					{
						...selection(),
						config: config({ comments: { min_severity: 'high' } }),
						agents: new Map([
							[
								'metadata',
								agent('metadata', {
									input: 'metadata',
									comments: { min_severity: 'medium' },
								}),
							],
						]),
						outcome: {
							bugs: kind === 'nit' ? [] : [finding],
							nits: kind === 'nit' ? [finding] : [],
							rejected: [],
						},
					},
					{
						threads: [],
						lines:
							location === 'outside'
								? new Map()
								: new Map([
										[
											finding.path,
											new Set([
												location === 'line' ? finding.line : finding.line + 100,
											]),
										],
									]),
						changedPlaces: new Set(),
					}
				)
				expect(plan.threads).toEqual([{ finding, kind, place: 'pull_request' }])
				expect(countOpenBugs(plan, [])).toBe(kind === 'bug' ? 1 : 0)
			})

	test.each([
		{ resolved: false, changed: false, disposition: 'repeated' },
		{ resolved: true, changed: false, disposition: 'dismissed' },
		{ resolved: true, changed: true, disposition: 'threads' },
	] as const)('keeps metadata matching $disposition', row => {
		const finding = bug({ agents: ['metadata'] })
		const thread = botThread({ resolved: row.resolved })
		const plan = planPublish(
			{
				...selection(),
				agents: new Map([
					['metadata', agent('metadata', { input: 'metadata' })],
				]),
				outcome: { bugs: [finding], nits: [], rejected: [] },
			},
			{
				threads: [thread],
				lines: new Map([[finding.path, new Set([finding.line])]]),
				changedPlaces: new Set(row.changed ? [thread.id] : []),
			}
		)
		expect(plan[row.disposition]).toEqual([
			{
				finding,
				kind: 'bug',
				...(row.disposition === 'threads' ? { place: 'pull_request' } : {}),
			},
		])
		expect(plan.threads).toHaveLength(row.disposition === 'threads' ? 1 : 0)
		expect(plan.repeated).toHaveLength(row.disposition === 'repeated' ? 1 : 0)
		expect(plan.dismissed).toHaveLength(row.disposition === 'dismissed' ? 1 : 0)
	})
	test.each([
		{
			label: 'open even if changed',
			resolved: false,
			changed: ['a', 'b'],
			repeated: 1,
			dismissed: 0,
		},
		{
			label: 'resolved unchanged',
			resolved: true,
			changed: [],
			repeated: 0,
			dismissed: 1,
		},
		{
			label: 'one resolved unchanged',
			resolved: true,
			changed: ['a'],
			repeated: 0,
			dismissed: 1,
		},
		{
			label: 'every resolved changed',
			resolved: true,
			changed: ['a', 'b'],
			repeated: 0,
			dismissed: 0,
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
		expect(plan.dismissed).toHaveLength(row.dismissed)
		expect(plan.threads).toHaveLength(1 - row.repeated - row.dismissed)
	})
	test.each([false, true])(
		'an open covering thread wins over an unchanged resolved thread, resolved first=%s',
		resolvedFirst => {
			const selected = selection()
			const resolved = botThread({ id: 'resolved', resolved: true })
			const open = botThread({ id: 'open' })
			const plan = planPublish(selected, {
				threads: resolvedFirst ? [resolved, open] : [open, resolved],
				lines: new Map(),
				changedPlaces: new Set(),
			})
			expect(plan.repeated).toEqual([
				{ finding: selected.outcome.bugs[0], kind: 'bug' },
			])
			expect(plan.dismissed).toEqual([])
			expect(plan.threads).toEqual([])
		}
	)
	test('dismissed bugs do not count as open bugs', () => {
		const selected = selection()
		const threads = [botThread({ resolved: true })]
		const plan = planPublish(selected, {
			threads,
			lines: new Map(),
			changedPlaces: new Set(),
		})
		expect(plan.dismissed).toEqual([
			{ finding: selected.outcome.bugs[0], kind: 'bug' },
		])
		expect(countOpenBugs(plan, threads)).toBe(0)
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
					dismissed: [],
					summaryNits: [],
				},
				threads
			)
		).toBe(2)
	})
})
