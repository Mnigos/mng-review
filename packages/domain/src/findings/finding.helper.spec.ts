import { SEVERITIES } from '../config/review-config.constants'
import { finding, rawFinding } from '../shared/mocks/domain-test.helper'
import {
	FINGERPRINT_LENGTH,
	NEAR_LINES,
	SAME_TITLE_OVERLAP,
} from './finding.constants'
import {
	toFingerprint,
	isSameRootCause,
	mergeFindings,
	sortFindings,
	toFinding,
	getSeverityRank,
	isAtLeast,
	getTitleWords,
} from './finding.helper'

describe('finding identity and merging', () => {
	test('fingerprint survives line shifts, case, punctuation, numbers and word order', () => {
		const original = finding({
			title: 'The balance loses 2 duplicate charges.',
			line: 2,
		})
		const moved = finding({
			title: '`CHARGES`: duplicate balance loses 900!',
			line: 90,
		})
		expect(toFingerprint(original)).toBe(toFingerprint(moved))
		expect(toFingerprint(original)).not.toBe(
			toFingerprint({ ...original, path: 'src/billing/refund.ts' })
		)
		expect(toFingerprint(original)).not.toBe(
			toFingerprint({ ...original, title: 'Missing ownership guard' })
		)
	})
	test('fingerprint ignores hyphen punctuation like other code punctuation', () => {
		expect(
			toFingerprint(finding({ title: 'Duplicate-charge loses balance' }))
		).toBe(toFingerprint(finding({ title: 'Duplicate charge loses balance' })))
	})
	test.each([
		['same fingerprint across distant lines', { line: 200 }, true],
		[
			'same line with unrelated title',
			{ title: 'Missing ownership guard' },
			false,
		],
		[
			'nearby overlapping titles',
			{ line: 5, title: 'Duplicate charge loses balance twice' },
			true,
		],
		[
			'nearby unrelated titles',
			{ line: 3, title: 'Missing ownership guard' },
			false,
		],
		[
			'far overlapping titles',
			{ line: 6, title: 'Duplicate charge loses balance twice' },
			false,
		],
		['different file', { path: 'src/billing/refund.ts' }, false],
		['bug and nit', { kind: 'nit' as const }, false],
	] as const)('sameRootCause: %s', (_name, overrides, expected) => {
		const a = finding()
		const b = finding(overrides)
		expect(isSameRootCause(a, b)).toBe(expected)
		expect(isSameRootCause(b, a)).toBe(expected)
	})
	test('merge keeps the highest severity and unions agents, models and evidence without mutating inputs', () => {
		const low = finding({
			severity: 'low',
			agents: ['billing', 'reviewer'],
			models: ['gpt-6.1-sol', 'claude-opus-5-5'],
			evidence: [
				'src/billing/charge.ts:2 charge',
				'src/billing/charge.ts:4 retry',
			],
			suggestion: 'Deduplicate the invoice.',
		})
		const high = finding({
			severity: 'critical',
			line: 80,
			agents: ['reviewer'],
			models: ['claude-opus-5-5'],
			evidence: ['src/billing/charge.ts:2 charge'],
		})
		const originals = structuredClone([low, high])
		const merged = mergeFindings([low, high])
		expect(merged).toHaveLength(1)
		expect(merged[0]).toMatchObject({
			severity: 'critical',
			line: 80,
			title: high.title,
			suggestion: low.suggestion,
		})
		expect(merged[0]?.agents.toSorted()).toEqual(['billing', 'reviewer'])
		expect(merged[0]?.models.toSorted()).toEqual([
			'claude-opus-5-5',
			'gpt-6.1-sol',
		])
		expect(merged[0]?.evidence).toEqual([
			...high.evidence,
			'src/billing/charge.ts:4 retry',
		])
		expect([low, high]).toEqual(originals)
	})
	test('the same finding from two models records both models without duplicates', () => {
		const sol = finding({ models: ['gpt-6.1-sol'] })
		const opus = finding({ models: ['claude-opus-5-5'] })
		expect(mergeFindings([sol, opus, sol])).toEqual([
			{ ...sol, models: ['gpt-6.1-sol', 'claude-opus-5-5'] },
		])
	})
	test('merge keeps unrelated findings on the same line separate', () => {
		const duplicate = finding()
		const ownership = finding({
			title: 'Missing ownership guard',
			agents: ['ownership'],
			models: ['claude-opus-5-5'],
		})
		expect(duplicate.path).toBe(ownership.path)
		expect(duplicate.line).toBe(ownership.line)
		expect(mergeFindings([duplicate, ownership])).toEqual([
			duplicate,
			ownership,
		])
	})
	test('merge preserves distinct roots, files, distant lines and nit findings', () => {
		const entries = [
			finding(),
			finding({ title: 'Missing guard', line: 180 }),
			finding({ path: 'src/billing/refund.ts' }),
			finding({ kind: 'nit' }),
			finding({ title: 'Duplicate charge loses balance twice', line: 90 }),
		]
		expect(mergeFindings(entries)).toHaveLength(5)
	})
	test('sorts severity descending, then path and line, without mutating input', () => {
		const entries = [
			finding({ severity: 'low' }),
			finding({ path: 'src/z.ts', line: 1 }),
			finding({ path: 'src/a.ts', line: 9 }),
			finding({ path: 'src/a.ts', line: 2 }),
			finding({ severity: 'critical' }),
		]
		const original = [...entries]
		expect(sortFindings(entries)).toEqual([
			entries[4],
			entries[3],
			entries[2],
			entries[1],
			entries[0],
		])
		expect(entries).toEqual(original)
	})
})

describe('finding transformations and severity', () => {
	test('attributes a report, computes its fingerprint and omits null suggestions', () => {
		const reported = rawFinding({ suggestion: null })
		const before = structuredClone(reported)
		const attributed = toFinding(reported, {
			agent: 'auth',
			model: 'model-a',
			kind: 'nit',
		})
		expect(attributed).toEqual({
			...rawFinding(),
			agents: ['auth'],
			models: ['model-a'],
			kind: 'nit',
			fingerprint: toFingerprint(reported),
		})
		expect(attributed).not.toHaveProperty('suggestion')
		expect(reported).toEqual(before)
		expect(
			toFinding(rawFinding({ suggestion: 'Deduplicate the invoice.' }), {
				agent: 'reviewer',
				model: 'model-b',
				kind: 'bug',
			}).suggestion
		).toBe('Deduplicate the invoice.')
	})
	test('ranks and compares all severity floors inclusively in exported order', () => {
		for (const [rank, severity] of SEVERITIES.entries()) {
			expect(getSeverityRank(severity)).toBe(rank)
			for (const [floorRank, floor] of SEVERITIES.entries())
				expect(isAtLeast(severity, floor)).toBe(rank >= floorRank)
		}
	})
	test('extracts lowercase title words without stop words, numbers or code punctuation', () => {
		expect(
			getTitleWords('The `Charge/Balance` is [lost] at 123, duplicate-charge!')
		).toEqual(['charge', 'balance', 'lost', 'duplicate', 'charge'])
		expect(getTitleWords('the and 123')).toEqual([])
	})
	test('fingerprints use the documented SHA-256 contract and ignore duplicate content words', () => {
		expect(toFingerprint({ path: 'a.ts', title: 'The guard' })).toBe(
			'9ba846f7caed1e34'
		)
		expect(toFingerprint(finding())).toMatch(
			new RegExp(`^[a-f0-9]{${FINGERPRINT_LENGTH}}$`, 'u')
		)
		expect(toFingerprint({ path: 'a.ts', title: 'guard guard' })).toBe(
			toFingerprint({ path: 'a.ts', title: 'guard' })
		)
	})
	test('root-cause distance is inclusive and Jaccard overlap meets the exported threshold', () => {
		const original = finding({ title: 'alpha beta gamma' })
		const overlapping = finding({
			title: 'alpha beta delta',
			line: original.line + NEAR_LINES,
		})
		expect(SAME_TITLE_OVERLAP).toBe(2 / 4)
		expect(isSameRootCause(original, overlapping)).toBeTruthy()
		expect(
			isSameRootCause(original, { ...overlapping, line: overlapping.line + 1 })
		).toBe(false)
		expect(
			isSameRootCause(original, finding({ title: 'alpha delta epsilon' }))
		).toBe(false)
	})
	test('empty content-word sets do not merge merely by proximity', () => {
		expect(
			isSameRootCause(
				finding({ title: 'the', fingerprint: 'first' }),
				finding({ title: 'and', fingerprint: 'second' })
			)
		).toBe(false)
	})
	test('a higher-severity suggestion wins and empty input remains empty', () => {
		const high = finding({
			severity: 'high',
			suggestion: 'Keep the unique invoice key.',
		})
		expect(
			mergeFindings([finding({ suggestion: 'Alternative.' }), high])[0]
				?.suggestion
		).toBe(high.suggestion)
		expect(mergeFindings([])).toEqual([])
		expect(sortFindings([])).toEqual([])
	})
})
