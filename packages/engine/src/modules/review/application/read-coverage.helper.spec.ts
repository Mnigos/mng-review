import { Response } from 'effect/ai'
import { unifiedDiff } from '../../../shared/mocks/domain-test.helper'
import { BILLING_PATH } from '../../../shared/mocks/review-test.helper'
import type { ToolOutput } from './agent-loop.types'
import {
	addToolReads,
	getChangedLines,
	getDiffParts,
	getUnreadFiles,
	isWholeRead,
	NO_READS,
	type ReadCoverage,
} from './read-coverage.helper'

const OTHER_PATH = 'src/other.ts'
const DIFF = `${unifiedDiff(BILLING_PATH, 3)}${unifiedDiff(OTHER_PATH)}`
const CHANGED = getChangedLines(DIFF)
const ADDED = getChangedLines(addedDiff(BILLING_PATH, 3))
/** A hunk at head line 10 with three context lines around a deleted check. */
const DELETION = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -10,4 +10,3 @@ fn\n keep\n-check\n keep\n keep\n`

/** A diff of `path` that only adds `lines` lines at the top, so a head read can show all of it. */
function addedDiff(path: string, lines: number): string {
	return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${lines} @@\n${'+added\n'.repeat(lines)}`
}

/** A tool output the model received for a call of `name` on `path`. */
function output(
	name: string,
	path: string,
	result: Omit<ToolOutput, 'call' | 'output'> = {}
): ToolOutput {
	const params: unknown = { path }
	const call = Response.toolCallPart({
		id: name,
		providerExecuted: false,
		name,
		params,
	})
	return { call, output: 'text', ...result }
}

/** The reads after the outputs, in order. */
function readAll(outputs: readonly ToolOutput[]): ReadCoverage {
	return outputs.reduce(addToolReads, NO_READS)
}

/** A `read_file` at `ref` that showed `start` to `end` of the billing file. */
function readFile(start: number, end: number, ref: 'head' | 'base' = 'head') {
	return output('read_file', BILLING_PATH, {
		shown: { ref, path: BILLING_PATH, lines: { start, end }, truncated: false },
	})
}

describe('getChangedLines', () => {
	test('names the head lines a file adds', () => {
		expect(ADDED).toEqual(new Map([[BILLING_PATH, [1, 2, 3]]]))
	})
	test('counts context lines toward the head line numbers', () => {
		const diff = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -10,2 +10,3 @@ fn\n keep\n+new\n keep\n`
		expect(getChangedLines(diff).get('a.ts')).toEqual([11])
	})
	test('a file that deletes a line names no head line, so only its diff reads it', () => {
		expect(CHANGED).toEqual(
			new Map([
				[BILLING_PATH, []],
				[OTHER_PATH, []],
			])
		)
		expect(getChangedLines(DELETION).get('a.ts')).toEqual([])
	})
})

describe('getDiffParts', () => {
	test('splits a page across the file sections it holds', () => {
		const split = DIFF.indexOf('diff --git', 1)
		expect(getDiffParts(DIFF, 0, split + 5)).toEqual([
			{ path: BILLING_PATH, size: split, from: 0, to: split },
			{
				path: OTHER_PATH,
				size: DIFF.length - split,
				from: 0,
				to: 5,
			},
		])
	})
})

describe('isWholeRead', () => {
	const whole = getDiffParts(DIFF, 0, DIFF.length)
	const middle = DIFF.indexOf('+after')
	test('every page of a file diff reads it', () => {
		const reads = readAll([
			output('diff', BILLING_PATH, { diff: getDiffParts(DIFF, 0, middle) }),
			output('diff', BILLING_PATH, {
				diff: getDiffParts(DIFF, middle, DIFF.length),
			}),
		])
		expect(isWholeRead(reads, BILLING_PATH, CHANGED.get(BILLING_PATH))).toBe(
			true
		)
		expect(
			getUnreadFiles(reads, { paths: [BILLING_PATH], changed: CHANGED })
		).toEqual([])
	})
	test('one page of a long diff does not read the file', () => {
		const reads = readAll([
			output('diff', BILLING_PATH, { diff: getDiffParts(DIFF, 0, middle) }),
		])
		expect(isWholeRead(reads, BILLING_PATH, CHANGED.get(BILLING_PATH))).toBe(
			false
		)
	})
	test('a whole-change diff reads every file in it', () => {
		const reads = readAll([output('diff', '', { diff: whole })])
		expect(
			getUnreadFiles(reads, {
				paths: [BILLING_PATH, OTHER_PATH],
				changed: CHANGED,
			})
		).toEqual([])
	})
	test('read_file at the head over every added line reads the file', () => {
		expect(
			isWholeRead(
				readAll([readFile(1, 2), readFile(3, 40)]),
				BILLING_PATH,
				ADDED.get(BILLING_PATH)
			)
		).toBe(true)
	})
	test('a partial read_file does not read the file', () => {
		expect(
			isWholeRead(
				readAll([readFile(1, 2)]),
				BILLING_PATH,
				ADDED.get(BILLING_PATH)
			)
		).toBe(false)
	})
	test('read_file at the base does not read the head change', () => {
		expect(
			isWholeRead(
				readAll([readFile(1, 40, 'base')]),
				BILLING_PATH,
				ADDED.get(BILLING_PATH)
			)
		).toBe(false)
	})
	for (const [name, diff] of [
		['a deletion-only hunk', DELETION],
		['a hunk that also adds', DIFF],
	] as const)
		test(`read_file at the head never reads ${name} without its diff`, () => {
			const path = name === 'a deletion-only hunk' ? 'a.ts' : BILLING_PATH
			const reads = readAll([
				output('read_file', path, {
					shown: {
						ref: 'head',
						path,
						lines: { start: 1, end: 40 },
						truncated: false,
					},
				}),
			])
			expect(isWholeRead(reads, path, getChangedLines(diff).get(path))).toBe(
				false
			)
		})
	test('blame does not read the file', () => {
		const reads = readAll([output('blame', BILLING_PATH)])
		expect(isWholeRead(reads, BILLING_PATH, CHANGED.get(BILLING_PATH))).toBe(
			false
		)
	})
	test('a file whose changed lines are unknown is read only through its diff', () => {
		expect(
			isWholeRead(readAll([readFile(1, 40)]), BILLING_PATH, undefined)
		).toBe(false)
	})
})

describe('getUnreadFiles', () => {
	const coverage = {
		paths: [BILLING_PATH, OTHER_PATH, 'a.ts', 'src/added.ts'],
		changed: new Map([
			...CHANGED,
			...getChangedLines(DELETION),
			...getChangedLines(addedDiff('src/added.ts', 3)),
		]),
	}
	test('names each file not received whole with why', () => {
		const middle = DIFF.indexOf('+after')
		const reads = readAll([
			output('diff', BILLING_PATH, { diff: getDiffParts(DIFF, 0, middle) }),
			output('read_file', 'a.ts', {
				shown: {
					ref: 'head',
					path: 'a.ts',
					lines: { start: 1, end: 40 },
					truncated: false,
				},
			}),
			output('read_file', 'src/added.ts', {
				shown: {
					ref: 'head',
					path: 'src/added.ts',
					lines: { start: 1, end: 2 },
					truncated: false,
				},
			}),
			output('blame', OTHER_PATH),
		])
		expect(getUnreadFiles(reads, coverage)).toEqual([
			{ path: BILLING_PATH, reason: 'partial' },
			{ path: OTHER_PATH, reason: 'untouched' },
			{ path: 'a.ts', reason: 'deletions' },
			{ path: 'src/added.ts', reason: 'partial' },
		])
	})
	test('leaves out the files whose whole diff came back', () => {
		const reads = readAll([
			output('diff', '', { diff: getDiffParts(DIFF, 0, DIFF.length) }),
		])
		expect(getUnreadFiles(reads, coverage)).toEqual([
			{ path: 'a.ts', reason: 'untouched' },
			{ path: 'src/added.ts', reason: 'untouched' },
		])
	})
})
