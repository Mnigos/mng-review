import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { rawFinding } from '../shared/mocks/domain-test.helper'
import {
	MAX_FINDING_FIX_CHARS,
	MAX_FINDING_IMPACT_CHARS,
	MAX_FINDING_STEP_CHARS,
	MAX_FINDING_TITLE_CHARS,
} from './finding.constants'
import { FindingsAnswerError } from './finding.errors'
import { addLaterFindings, parseFindingsAnswer } from './findings-answer.parser'

layer(Layer.empty)('parseFindingsAnswer', test => {
	test.effect(
		'drops malformed entries, counts them and normalizes relative paths',
		() =>
			Effect.gen(function* () {
				expect(
					yield* parseFindingsAnswer({
						findings: [
							rawFinding({ path: './src/billing/charge.ts' }),
							null,
							{ title: 'missing fields' },
							rawFinding({ path: '../outside.ts' }),
							rawFinding({ path: 'a/../../outside.ts' }),
							rawFinding({ path: 'src\\charge.ts' }),
							rawFinding({ path: 'bad\0path' }),
							rawFinding({ path: '.' }),
						],
					})
				).toEqual({ findings: [rawFinding()], dropped: 7 })
			})
	)
	test.effect('accepts a bare list or an empty findings envelope', () =>
		Effect.gen(function* () {
			expect(yield* parseFindingsAnswer([rawFinding()])).toEqual({
				findings: [rawFinding()],
				dropped: 0,
			})
			expect(yield* parseFindingsAnswer({ findings: [] })).toEqual({
				findings: [],
				dropped: 0,
			})
			expect(yield* parseFindingsAnswer([])).toEqual({
				findings: [],
				dropped: 0,
			})
		})
	)
	for (const input of [
		null,
		{},
		{ findings: null },
		{ findings: 'wrong' },
		undefined,
	])
		test.effect(`rejects malformed envelope ${JSON.stringify(input)}`, () =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(parseFindingsAnswer(input))
				expect(error).toBeInstanceOf(FindingsAnswerError)
				expect(error.message).toBe('expected an object with a "findings" array')
			})
		)
	for (const path of ['/etc/passwd', 'C:/x', 'c:x', '', 'a/..'])
		test.effect(
			`drops unsafe or root finding path ${JSON.stringify(path)}`,
			() =>
				Effect.gen(function* () {
					expect(
						yield* parseFindingsAnswer({ findings: [rawFinding({ path })] })
					).toEqual({ findings: [], dropped: 1 })
				})
		)
})

describe('addLaterFindings', () => {
	test('keeps the original report and adds only different fingerprints, summing dropped entries', () => {
		const original = rawFinding({ evidence: ['first evidence'] })
		const duplicate = rawFinding({
			title: 'Balance loses duplicate charge',
			line: 90,
			severity: 'high',
		})
		const later = rawFinding({ title: 'Missing ownership guard' })
		const otherPath = rawFinding({ path: 'src/refund.ts' })
		const first = { findings: [original], dropped: 2 }
		const second = { findings: [duplicate, later, otherPath], dropped: 3 }
		expect(addLaterFindings(first, second)).toEqual({
			findings: [original, later, otherPath],
			dropped: 5,
		})
		expect(first.findings).toEqual([original])
		expect(second.findings).toEqual([duplicate, later, otherPath])
	})
	test('an empty continuation preserves the first findings', () => {
		const first = { findings: [rawFinding()], dropped: 1 }
		expect(addLaterFindings(first, { findings: [], dropped: 0 })).toEqual(first)
	})
	test('an empty first answer accepts later findings', () => {
		const later = { findings: [rawFinding()], dropped: 1 }
		expect(addLaterFindings({ findings: [], dropped: 0 }, later)).toEqual(later)
	})
})

/** `count` words separated by spaces. */
function words(count: number): string {
	return 'word '.repeat(count).trim()
}

layer(Layer.empty)('parseFindingsAnswer text limits', test => {
	test.effect(
		'cuts an over-long title, impact, fix and trigger step and keeps every finding',
		() =>
			Effect.gen(function* () {
				const parsed = yield* parseFindingsAnswer({
					findings: [
						rawFinding(),
						rawFinding({
							title: words(60),
							impact: words(200),
							suggestion: words(100),
							trigger: `${words(80)}\nshort step`,
						}),
					],
				})
				expect(parsed.dropped).toBe(0)
				expect(parsed.findings).toHaveLength(2)
				const [kept, cut] = parsed.findings
				expect(kept).toEqual(rawFinding())
				expect(cut?.title.length).toBeLessThanOrEqual(MAX_FINDING_TITLE_CHARS)
				expect(cut?.impact.length).toBeLessThanOrEqual(MAX_FINDING_IMPACT_CHARS)
				expect(cut?.suggestion?.length).toBeLessThanOrEqual(
					MAX_FINDING_FIX_CHARS
				)
				const [first, second] = cut?.trigger.split('\n') ?? []
				expect(first?.length).toBeLessThanOrEqual(MAX_FINDING_STEP_CHARS)
				expect(second).toBe('short step')
				for (const text of [cut?.title, cut?.impact, cut?.suggestion, first])
					expect(text).toMatch(/word…$/u)
			})
	)
	test.effect('puts a title and a fix with line breaks on one line', () =>
		Effect.gen(function* () {
			const parsed = yield* parseFindingsAnswer([
				rawFinding({ title: 'first\r\n  last', suggestion: 'one\ntwo' }),
			])
			expect(parsed.findings[0]).toMatchObject({
				title: 'first last',
				suggestion: 'one two',
			})
		})
	)
	test.effect('keeps a null suggestion and text exactly at the limits', () =>
		Effect.gen(function* () {
			const finding = rawFinding({
				title: 'x'.repeat(MAX_FINDING_TITLE_CHARS),
				impact: 'x'.repeat(MAX_FINDING_IMPACT_CHARS),
				suggestion: null,
			})
			expect((yield* parseFindingsAnswer([finding])).findings).toEqual([
				finding,
			])
		})
	)
})
