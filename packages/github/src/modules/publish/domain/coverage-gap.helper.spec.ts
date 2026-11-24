import {
	agentReport,
	botThread,
	bug,
	cutTitleBug,
	cutTitleFingerprint,
	report,
} from '../../../shared/mocks/publish-test.helper'
import {
	getCoverageGap,
	getCoverageGaps,
	hasFailedRuns,
} from './coverage-gap.helper'

type Report = ReturnType<typeof report>
type ChangedFile = Report['planReport']['change']['files'][number]

/** A report whose plan ran and reported every planned finder and kept nothing. */
function coveredReport(): Report {
	const reviewed = report()
	return {
		...reviewed,
		bugs: [],
		agents: reviewed.planReport.plan.runs.map(run => ({
			...agentReport(),
			name: run.name,
		})),
	}
}

/** A changed file with an optional skip reason. */
function changedFile(
	path: string,
	skipped?: ChangedFile['skipped']
): ChangedFile {
	return {
		path,
		status: 'modified',
		additions: 1,
		deletions: 1,
		binary: skipped === 'binary',
		sizeBytes: 10,
		...(skipped ? { skipped } : {}),
	}
}

/** The covered report over `files`, listed in both the change and the plan. */
function withFiles(files: readonly ChangedFile[]): Report {
	const covered = coveredReport()
	return {
		...covered,
		planReport: {
			...covered.planReport,
			change: { ...covered.planReport.change, files },
			plan: { ...covered.planReport.plan, files },
		},
	}
}

test('a covered report has no gap', () => {
	expect(getCoverageGap(coveredReport(), [])).toBeUndefined()
})

describe('hasFailedRuns', () => {
	test('a report of every planned run with none failed has no failed run', () => {
		expect(hasFailedRuns(coveredReport())).toBe(false)
	})
	test('a planned run without a report is a failed run', () => {
		expect(hasFailedRuns({ ...coveredReport(), agents: [] })).toBe(true)
	})
	for (const failure of [
		{ status: 'failed' },
		{ error: '1 of 2 units did not finish: LoopError' },
		{ endpointError: true },
	] as const)
		test(`an agent with ${JSON.stringify(failure)} is a failed run`, () => {
			const covered = coveredReport()
			expect(
				hasFailedRuns({
					...covered,
					agents: covered.agents.map(agent => ({ ...agent, ...failure })),
				})
			).toBe(true)
		})
	test('an endpoint error is a failed run', () => {
		expect(
			hasFailedRuns({ ...coveredReport(), endpointError: 'Unavailable' })
		).toBe(true)
	})
	test('nits, unverified findings and skipped files are no failed run', () => {
		expect(
			hasFailedRuns({
				...withFiles([changedFile('big.json', 'too_large')]),
				nits: [bug({ kind: 'nit' })],
			})
		).toBe(false)
	})
})

test('skipped files are counted against every changed file', () => {
	const files = [
		changedFile('a.ts'),
		changedFile('big-1.json', 'too_large'),
		changedFile('big-2.json', 'too_large'),
		changedFile('logo.png', 'binary'),
		changedFile('generated.ts', 'skip.paths'),
	]
	expect(getCoverageGap(withFiles(files), [])).toStrictEqual({
		kind: 'skipped',
		tooLarge: 2,
		binary: 1,
		files: 5,
	})
})

test('a file skipped in the plan only still counts once', () => {
	const covered = withFiles([changedFile('a.ts'), changedFile('b.ts')])
	expect(
		getCoverageGap(
			{
				...covered,
				planReport: {
					...covered.planReport,
					plan: {
						...covered.planReport.plan,
						files: [changedFile('a.ts'), changedFile('b.ts', 'too_large')],
					},
				},
			},
			[]
		)
	).toStrictEqual({ kind: 'skipped', tooLarge: 1, binary: 0, files: 2 })
})

test('a budget stop is reported before failed runs and unread files', () => {
	const covered = coveredReport()
	expect(
		getCoverageGap(
			{
				...covered,
				incomplete: { reason: 'budget', unfinished: ['reviewer'] },
				agents: covered.agents.map(agent => ({
					...agent,
					status: 'failed' as const,
					unread: 3,
				})),
			},
			[]
		)
	).toStrictEqual({ kind: 'budget' })
	expect(
		getCoverageGap(
			{
				...covered,
				agents: covered.agents.map(agent => ({
					...agent,
					unfinished: ['reviewer: unit 2'],
				})),
			},
			[]
		)
	).toStrictEqual({ kind: 'budget' })
})

test('failed runs count missing reports and failed or erroring ones against the plan', () => {
	const covered = coveredReport()
	const runs = covered.planReport.plan.runs.length
	expect(
		getCoverageGap(
			{
				...covered,
				agents: covered.agents.map(agent => ({
					...agent,
					error: '1 of 2 units did not finish: LoopError',
				})),
			},
			[]
		)
	).toStrictEqual({ kind: 'failed', failed: covered.agents.length, runs })
	expect(getCoverageGap({ ...covered, agents: [] }, [])).toStrictEqual({
		kind: 'failed',
		failed: runs,
		runs,
	})
	expect(
		getCoverageGap({ ...covered, endpointError: 'Unavailable' }, [])
	).toStrictEqual({ kind: 'failed', failed: 1, runs })
})

test('files reviewer runs answered without reading count as the most one run left, since reports carry no paths', () => {
	const covered = coveredReport()
	expect(
		getCoverageGap(
			{
				...covered,
				agents: [
					...covered.agents.map(agent => ({ ...agent, unread: 2 })),
					{ ...agentReport(), name: 'reviewer', unread: 2 },
					{ ...agentReport(), name: 'reviewer', unread: 1 },
				],
			},
			[]
		)
	).toStrictEqual({ kind: 'unread', unread: 2 })
})

test('kept findings are counted before open threads that never block', () => {
	const covered = coveredReport()
	const nit = botThread({ marker: { ...botThread().marker, kind: 'nit' } })
	expect(
		getCoverageGap({ ...covered, bugs: [bug()], nits: [bug()] }, [nit])
	).toStrictEqual({ kind: 'findings', findings: 2 })
	expect(getCoverageGap(covered, [nit, nit])).toStrictEqual({
		kind: 'findings',
		findings: 2,
	})
})

test('open threads no kept finding matches add to the kept findings, a matching one counts once', () => {
	const covered = coveredReport()
	const matching = botThread({ marker: { ...botThread().marker, kind: 'nit' } })
	const unrelated = botThread({
		id: 'unrelated',
		marker: {
			...botThread().marker,
			kind: 'nit',
			fingerprint: 'unrelated-nit',
		},
	})
	expect(
		getCoverageGap({ ...covered, nits: [bug()] }, [unrelated])
	).toStrictEqual({ kind: 'findings', findings: 2 })
	expect(
		getCoverageGap({ ...covered, nits: [bug()] }, [matching, unrelated])
	).toStrictEqual({ kind: 'findings', findings: 2 })
})

test("an open thread with the fingerprint of a kept finding's cut title counts once", () => {
	const nit = botThread({
		marker: {
			...botThread().marker,
			kind: 'nit',
			fingerprint: cutTitleFingerprint(),
		},
	})
	expect(
		getCoverageGap({ ...coveredReport(), nits: [cutTitleBug()] }, [nit])
	).toStrictEqual({ kind: 'findings', findings: 1 })
})

test('a plan without the main reviewer is reported first', () => {
	const covered = coveredReport()
	expect(
		getCoverageGap(
			{
				...withFiles([changedFile('big.json', 'too_large')]),
				planReport: {
					...covered.planReport,
					plan: {
						...covered.planReport.plan,
						runs: covered.planReport.plan.runs.filter(
							run => run.role !== 'reviewer'
						),
					},
				},
			},
			[]
		)
	).toStrictEqual({ kind: 'no-reviewer' })
})

test('every gap is listed in order, so a quick run over a skipped file names both', () => {
	const skipped = withFiles([
		changedFile('a.ts'),
		changedFile('big.json', 'too_large'),
	])
	expect(
		getCoverageGaps(
			{
				...skipped,
				planReport: {
					...skipped.planReport,
					plan: {
						...skipped.planReport.plan,
						runs: skipped.planReport.plan.runs.filter(
							run => run.role !== 'reviewer'
						),
					},
				},
			},
			[]
		)
	).toStrictEqual([
		{ kind: 'no-reviewer' },
		{ kind: 'skipped', tooLarge: 1, binary: 0, files: 2 },
	])
	expect(getCoverageGaps(coveredReport(), [])).toStrictEqual([])
})

test('a run whose reading did not fit the cap names the cap before the unread files', () => {
	const covered = coveredReport()
	expect(
		getCoverageGaps(
			{
				...covered,
				capped: { needed: 1_600_000, cap: 1_400_000 },
				agents: covered.agents.map(agent => ({ ...agent, unread: 3 })),
			},
			[]
		)
	).toStrictEqual([
		{ kind: 'cap', cap: 1_400_000 },
		{ kind: 'unread', unread: 3 },
	])
})
