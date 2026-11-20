import { NEAR_LINES, SAME_TITLE_OVERLAP } from '@mng-review/domain'
import { agent, config } from '../../../shared/mocks/domain-test.helper'
import {
	botThread,
	bug,
	RULES,
} from '../../../shared/mocks/publish-test.helper'
import { THREAD_KINDS, type ThreadKind } from './publish-marker.schema'
import {
	countOpenBugs,
	countUnthreadedBugs,
	getMatchingThreads,
	getPublishedFindings,
	isPullRequestFinding,
	planPublish,
	type PublishSelection,
} from './publish-plan.helper'
import type { BotThread, ThreadPlace } from './publish.types'

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
			test(`${existing} thread coverage of ${kind} on the same line with different titles and fingerprints`, () => {
				const thread = botThread()
				const allowed =
					kind === existing || (kind === 'unverified' && existing === 'bug')
				expect(
					getMatchingThreads({ finding: bug(), kind }, [
						{
							...thread,
							marker: {
								...thread.marker,
								kind: existing,
								fingerprint: 'different',
								title: 'Retry overwrites stored records',
							},
						},
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
		'outdated thread on a nearby original line matches only by fingerprint: same=%s',
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
	test.each([false, true])(
		'outdated thread on the same original line with a reworded title matches only while open: resolved=%s',
		resolved => {
			const thread = botThread({ line: undefined, resolved })
			expect(
				getMatchingThreads({ finding: bug(), kind: 'bug' }, [
					{
						...thread,
						marker: {
							...thread.marker,
							fingerprint: 'different',
							title: 'Retry overwrites stored records',
						},
					},
				])
			).toHaveLength(resolved ? 0 : 1)
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
			distance: 1,
			onFile: false,
			title: 'Unrelated parser crashes',
			matches: false,
		},
		{
			path: 'src/store.ts',
			distance: 0,
			onFile: false,
			title: 'Unrelated parser crashes',
			matches: true,
		},
		{
			path: 'src/store.ts',
			distance: 1,
			onFile: false,
			title: 'Retry overwrites stored records',
			matches: false,
		},
		{
			path: 'src/store.ts',
			distance: 1,
			onFile: false,
			title: 'Duplicate write loses data',
			matches: true,
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
			const thread = botThread({ resolved: true })
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
	test.each([false, true])(
		'a reworded title on the same line is repeated only while the thread is open: resolved=%s',
		resolved => {
			const finding = bug({
				title: 'Retry overwrites stored records',
				fingerprint: 'reworded',
			})
			const thread = botThread({ resolved })
			expect(getMatchingThreads({ finding, kind: 'bug' }, [thread])).toEqual(
				resolved ? [] : [thread]
			)
			const plan = planPublish(
				{
					...selection(),
					outcome: { bugs: [finding], nits: [], rejected: [] },
				},
				{
					threads: [thread],
					lines: new Map([[finding.path, new Set([finding.line])]]),
					changedPlaces: new Set(),
				}
			)
			expect(plan.repeated).toEqual(resolved ? [] : [{ finding, kind: 'bug' }])
			expect(plan.threads).toEqual(
				resolved ? [{ finding, kind: 'bug', place: 'line' }] : []
			)
			expect(plan.dismissed).toEqual([])
		}
	)
	test('accepts the trade-off that two different findings on the same line both repeat one open thread', () => {
		const findings = [
			bug({ title: 'Retry overwrites stored records', fingerprint: 'retry' }),
			bug({ title: 'Unrelated parser crashes', fingerprint: 'parser' }),
		]
		const thread = botThread()
		for (const finding of findings)
			expect(getMatchingThreads({ finding, kind: 'bug' }, [thread])).toEqual([
				thread,
			])
		const plan = planPublish(
			{
				...selection(),
				outcome: { bugs: findings, nits: [], rejected: [] },
			},
			{
				threads: [thread],
				lines: new Map([[bug().path, new Set([bug().line])]]),
				changedPlaces: new Set(),
			}
		)
		expect(plan.repeated).toEqual(
			findings.map(finding => ({ finding, kind: 'bug' }))
		)
		expect(plan.threads).toEqual([])
		expect(plan.dismissed).toEqual([])
	})
	test('moves only metadata summary nits into pull request entries', () => {
		const metadata = bug({
			kind: 'nit',
			placement: 'summary',
			agents: ['metadata'],
		})
		const diff = bug({ kind: 'nit', placement: 'summary', agents: ['diff'] })
		const mixed = bug({
			kind: 'nit',
			placement: 'summary',
			agents: ['metadata', 'diff'],
		})
		const plan = planPublish(
			{
				...selection(),
				agents: new Map([
					['metadata', agent('metadata', { input: 'metadata' })],
					['diff', agent('diff', { input: 'incremental' })],
				]),
				outcome: { bugs: [], nits: [metadata, diff, mixed], rejected: [] },
			},
			{ threads: [], lines: new Map(), changedPlaces: new Set() }
		)
		expect(plan.threads).toEqual([
			{ finding: metadata, kind: 'nit', place: 'pull_request' },
		])
		expect(plan.summaryNits).toEqual([diff, mixed])
		expect(countOpenBugs(plan, [])).toBe(0)
		expect(countUnthreadedBugs(plan, [])).toBe(0)
	})
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
						{
							finding: bug({ fingerprint: 'not-held' }),
							kind: 'bug',
							place: 'summary',
						},
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

describe('countUnthreadedBugs', () => {
	for (const place of [
		'line',
		'file',
		'summary',
		'pull_request',
		'unposted',
	] as const satisfies readonly ThreadPlace[])
		for (const kind of ['bug', 'nit', 'unverified'] as const)
			test(`counts a ${kind} at ${place} only when it is a bug without a thread`, () => {
				expect(
					countUnthreadedBugs(
						{
							threads: [
								{
									finding: bug({ kind: kind === 'nit' ? 'nit' : 'bug' }),
									kind,
									place,
								},
							],
							repeated: [],
							dismissed: [],
							summaryNits: [],
						},
						[]
					)
				).toBe(
					kind === 'bug' &&
						(place === 'summary' ||
							place === 'pull_request' ||
							place === 'unposted')
						? 1
						: 0
				)
			})

	test('adds bugs across summary places without counting repeated, dismissed or summary nits', () => {
		expect(
			countUnthreadedBugs(
				{
					threads: (['summary', 'pull_request', 'unposted'] as const).map(
						place => ({ finding: bug(), kind: 'bug', place })
					),
					repeated: [{ finding: bug(), kind: 'bug' }],
					dismissed: [{ finding: bug(), kind: 'bug' }],
					summaryNits: [bug({ kind: 'nit', placement: 'summary' })],
				},
				[]
			)
		).toBe(3)
	})
})

describe('countOpenBugs', () => {
	for (const kind of THREAD_KINDS)
		for (const place of [
			'line',
			'file',
			'summary',
			'pull_request',
			'unposted',
		] as const satisfies readonly ThreadPlace[])
			for (const listed of [false, true])
				test(`${kind} at ${place}, fresh thread listed=${listed}`, () => {
					const thread = botThread()
					expect(
						countOpenBugs(
							{
								threads: [{ finding: bug(), kind, place }],
								repeated: [],
								dismissed: [],
								summaryNits: [],
							},
							listed ? [{ ...thread, marker: { ...thread.marker, kind } }] : []
						)
					).toBe(kind === 'bug' ? 1 : 0)
				})
	for (const kind of THREAD_KINDS)
		test(`a ${kind} thread holds a planned bug only by an open bug fingerprint`, () => {
			const thread = botThread()
			expect(
				countOpenBugs(
					{
						threads: [{ finding: bug(), kind: 'bug', place: 'line' }],
						repeated: [],
						dismissed: [],
						summaryNits: [],
					},
					[{ ...thread, marker: { ...thread.marker, kind } }]
				)
			).toBe(1)
		})
	test('counts a planned bug whose fingerprint only belongs to a resolved thread', () => {
		expect(
			countOpenBugs(
				{
					threads: [{ finding: bug(), kind: 'bug', place: 'line' }],
					repeated: [],
					dismissed: [],
					summaryNits: [],
				},
				[botThread({ resolved: true })]
			)
		).toBe(1)
	})
	test('counts an open bug and a planned bug with different fingerprints', () => {
		expect(
			countOpenBugs(
				{
					threads: [
						{
							finding: bug({ fingerprint: 'new-bug' }),
							kind: 'bug',
							place: 'line',
						},
					],
					repeated: [],
					dismissed: [],
					summaryNits: [],
				},
				[botThread()]
			)
		).toBe(2)
	})
	test.each([false, true])(
		'counts two open threads with one fingerprint separately, planned bug=%s',
		planned => {
			expect(
				countOpenBugs(
					{
						threads: planned
							? [{ finding: bug(), kind: 'bug', place: 'line' }]
							: [],
						repeated: [],
						dismissed: [],
						summaryNits: [],
					},
					[botThread({ id: 'first' }), botThread({ id: 'second' })]
				)
			).toBe(2)
		}
	)
	for (const kind of THREAD_KINDS)
		for (const resolved of [false, true])
			test(`fresh ${kind} thread with resolved=${resolved}`, () => {
				const thread = botThread({ resolved })
				expect(
					countOpenBugs(
						{ threads: [], repeated: [], dismissed: [], summaryNits: [] },
						[{ ...thread, marker: { ...thread.marker, kind } }]
					)
				).toBe(kind === 'bug' && !resolved ? 1 : 0)
			})
})

describe('countUnthreadedBugs', () => {
	for (const place of [
		'line',
		'file',
		'summary',
		'pull_request',
		'unposted',
	] as const)
		for (const covering of [
			'none',
			'open-bug',
			'resolved-bug',
			'nit',
			'unverified',
			'different-fingerprint',
		] as const)
			test(`${place} bug held by ${covering}`, () => {
				const thread = botThread({ resolved: covering === 'resolved-bug' })
				const threads =
					covering === 'none'
						? []
						: [
								{
									...thread,
									marker: {
										...thread.marker,
										kind:
											covering === 'nit' || covering === 'unverified'
												? covering
												: ('bug' as const),
										fingerprint:
											covering === 'different-fingerprint'
												? 'other-bug'
												: thread.marker.fingerprint,
									},
								},
							]
				expect(
					countUnthreadedBugs(
						{
							threads: [{ finding: bug(), kind: 'bug', place }],
							repeated: [],
							dismissed: [],
							summaryNits: [],
						},
						threads
					)
				).toBe(
					place === 'line' || place === 'file' || covering === 'open-bug'
						? 0
						: 1
				)
			})
	test.each(['nit', 'unverified'] as const)(
		'does not count a planned %s',
		kind => {
			expect(
				countUnthreadedBugs(
					{
						threads: [{ finding: bug(), kind, place: 'summary' }],
						repeated: [],
						dismissed: [],
						summaryNits: [],
					},
					[]
				)
			).toBe(0)
		}
	)
})
