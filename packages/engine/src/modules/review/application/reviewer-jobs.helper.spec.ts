import {
	file,
	plannedRun,
	unifiedDiff,
} from '../../../shared/mocks/domain-test.helper'
import { SCOPE } from '../../../shared/mocks/review-test.helper'
import { fenceData } from '../../../utils/fence.util'
import { getReadingTokens } from '../domain/finder-budget.helper'
import { toEstimatedTokens } from '../domain/loop-budget.helper'
import { toOutputPage } from '../domain/output-part.helper'
import {
	CONTEXT_READ_TOKENS,
	MAX_TOOL_OUTPUT_CHARS,
	MAX_UNIT_DIFF_CHARS,
	MIN_READING_TURNS,
	MIN_UNIT_TOKENS,
	TOOL_OUTPUT_LABEL,
} from '../domain/review.constants'
import type { FinderContext, FinderJob } from './finder.types'
import {
	getReadingNeed,
	toReviewerJobs,
	toSizedJobs,
} from './reviewer-jobs.helper'

const LONG_PATH = 'src/billing/refund.ts'
/** A diff whose section takes four tool output pages. */
const LONG = unifiedDiff(
	LONG_PATH,
	Math.ceil((MAX_TOOL_OUTPUT_CHARS * 3.5) / 7)
)
const SHORT = unifiedDiff('src/billing/charge.ts')

/** A finder context for the main reviewer over `paths`. */
function reviewerContext(
	paths: readonly string[],
	overrides: Partial<FinderContext> = {}
): FinderContext {
	return {
		scope: {
			...SCOPE,
			change: { ...SCOPE.change, files: paths.map(path => file(path)) },
		},
		rules: { agents: [] },
		fanOut: false,
		fallback: undefined,
		tokens: { allowance: MIN_UNIT_TOKENS, runTokens: 700_000 },
		...overrides,
	}
}

/** A job of `tokens` that needs `need`. */
function job(tokens: number, need?: number): FinderJob {
	return {
		system: 'system',
		user: 'user',
		tools: [],
		tokens,
		...(need === undefined ? {} : { need }),
	}
}

describe('getReadingNeed', () => {
	test('plans every page of each cut file, a turn per page of the longest one', () => {
		const pages = [0, 1, 2, 3].reduce<{ offset: number; tokens: number }>(
			acc => {
				const page = toOutputPage(LONG, acc.offset)
				return {
					offset: page.end,
					tokens:
						acc.tokens +
						toEstimatedTokens(fenceData(TOOL_OUTPUT_LABEL, page.output)),
				}
			},
			{ offset: 0, tokens: 0 }
		)
		expect(pages.offset).toBe(LONG.length)
		expect(getReadingNeed(job(0), LONG + SHORT, [LONG_PATH])).toBe(
			getReadingTokens(
				toEstimatedTokens('systemuser'),
				pages.tokens + CONTEXT_READ_TOKENS,
				Math.max(MIN_READING_TURNS, 4)
			)
		)
	})
	test('a file outside the coverage costs nothing to read', () => {
		expect(getReadingNeed(job(0), LONG + SHORT, [])).toBe(
			getReadingTokens(
				toEstimatedTokens('systemuser'),
				CONTEXT_READ_TOKENS,
				MIN_READING_TURNS
			)
		)
	})
})

describe('toReviewerJobs', () => {
	test('a reviewer whose first message cuts a file carries what reading it needs', () => {
		const [reviewer] = toReviewerJobs({
			run: plannedRun({ files: [LONG_PATH, 'src/billing/charge.ts'] }),
			context: reviewerContext([LONG_PATH, 'src/billing/charge.ts']),
			diff: LONG + SHORT,
			narrowed: false,
		})
		expect(reviewer?.coverage).toEqual([LONG_PATH])
		expect(reviewer?.need).toBeGreaterThan(reviewer?.tokens ?? 0)
	})
	test('a reviewer that sees every file whole needs nothing more', () => {
		const [reviewer] = toReviewerJobs({
			run: plannedRun(),
			context: reviewerContext(['src/billing/charge.ts']),
			diff: SHORT,
			narrowed: false,
		})
		expect(reviewer?.coverage).toEqual([])
		expect(reviewer).not.toHaveProperty('need')
	})
	test('a deep review splits a large diff into more units than its share pays for', () => {
		const paths = ['a.ts', 'b.ts', 'c.ts']
		const diff = paths
			.map(path => unifiedDiff(path, Math.ceil(MAX_UNIT_DIFF_CHARS / 2 / 7)))
			.join('')
		expect(diff.length).toBeGreaterThan(MAX_UNIT_DIFF_CHARS)
		expect(
			toReviewerJobs({
				run: plannedRun({ files: paths }),
				context: reviewerContext(paths, { fanOut: true }),
				diff,
				narrowed: false,
			}).length
		).toBeGreaterThan(1)
	})
})

describe('toSizedJobs', () => {
	test('raises each job to its need when the room holds them all', () => {
		const sized = toSizedJobs(
			[[job(100, 400), job(100)], undefined, [job(50, 20)]],
			1000
		)
		expect(sized).toEqual({
			jobs: [
				[{ ...job(400, 400), granted: 300 }, job(100)],
				undefined,
				[job(50, 20)],
			],
			granted: 300,
			needed: 300,
			capped: false,
		})
	})
	test('cuts every grant alike past the room and says so', () => {
		const sized = toSizedJobs([[job(100, 400)], [job(100, 200)]], 200)
		expect(sized).toEqual({
			jobs: [
				[{ ...job(250, 400), granted: 150 }],
				[{ ...job(150, 200), granted: 50 }],
			],
			granted: 200,
			needed: 400,
			capped: true,
		})
	})
})

/** One hunk of 3000 added lines from `from`, in the code unit `unit`. */
function hunk(from: number, unit: string): string {
	return `@@ -${from} +${from},3000 @@ ${unit}\n-before\n${'+after\n'.repeat(3000)}`
}

describe('units that share a file', () => {
	test('size reading from the whole diff of the file, as diff(path) returns it', () => {
		const path = 'src/billing/split.ts'
		const diff = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunk(1, 'function one() {')}${hunk(5000, 'function two() {')}`
		const jobs = toReviewerJobs({
			run: plannedRun({ files: [path] }),
			context: reviewerContext([path], {
				fanOut: true,
				tokens: { allowance: MIN_UNIT_TOKENS * 2, runTokens: 700_000 },
			}),
			diff,
			narrowed: false,
		})
		expect(jobs).toHaveLength(2)
		for (const unit of jobs) {
			expect(unit.coverage).toEqual([path])
			expect(unit.need).toBe(getReadingNeed(unit, diff, [path]))
		}
	})
})
