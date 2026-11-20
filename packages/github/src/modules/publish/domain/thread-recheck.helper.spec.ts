import { botThread, bug } from '../../../shared/mocks/publish-test.helper'
import { MAX_RECHECKS } from './publish.constants'
import {
	getRecheckCandidates,
	toThreadFinding,
	getRotated,
} from './thread-recheck.helper'

const HEAD = 'new-head'

describe('getRecheckCandidates', () => {
	test.each(['bug', 'unverified'] as const)(
		'keeps an open %s from a known earlier commit with no reply',
		kind => {
			const thread = botThread()
			const candidate = { ...thread, marker: { ...thread.marker, kind } }
			expect(getRecheckCandidates([candidate], [], HEAD)).toEqual([candidate])
		}
	)
	test.each([
		{ resolved: true },
		{ replies: 1 },
		{ commit: undefined },
		{ commit: HEAD },
	])('excludes ineligible thread %j', overrides => {
		expect(getRecheckCandidates([botThread(overrides)], [], HEAD)).toEqual([])
	})
	test('never rechecks a nit', () => {
		const thread = botThread()
		expect(
			getRecheckCandidates(
				[{ ...thread, marker: { ...thread.marker, kind: 'nit' } }],
				[],
				HEAD
			)
		).toEqual([])
	})
	test.each(['bug', 'unverified'] as const)(
		'a matching published %s prevents rechecking',
		kind => {
			expect(
				getRecheckCandidates([botThread()], [{ finding: bug(), kind }], HEAD)
			).toEqual([])
		}
	)
	test('a published nit on the same line does not keep a bug thread from the re-check', () => {
		const thread = botThread()
		expect(
			getRecheckCandidates(
				[thread],
				[{ finding: bug({ title: 'A different nit title' }), kind: 'nit' }],
				HEAD
			)
		).toEqual([thread])
	})
	test('an unrelated published finding does not suppress the thread', () => {
		const thread = botThread()
		expect(
			getRecheckCandidates(
				[thread],
				[
					{
						finding: bug({
							path: 'src/elsewhere.ts',
							fingerprint: 'different-problem',
						}),
						kind: 'bug',
					},
				],
				HEAD
			)
		).toEqual([thread])
	})
})

describe('toThreadFinding', () => {
	test('rebuilds the original problem and identity from its marker', () => {
		const thread = botThread()
		expect(toThreadFinding(thread)).toEqual({
			path: thread.path,
			line: thread.line,
			severity: thread.marker.severity,
			title: thread.marker.title,
			trigger: bug().trigger,
			impact: bug().impact,
			evidence: [],
			kind: 'bug',
			agents: [thread.marker.agent],
			models: [],
			fingerprint: thread.marker.fingerprint,
		})
	})
	test('older markers use the title for trigger and impact', () => {
		const thread = botThread()
		const { trigger: _trigger, impact: _impact, ...marker } = thread.marker
		expect(toThreadFinding({ ...thread, marker })).toMatchObject({
			trigger: marker.title,
			impact: marker.title,
		})
	})
	test.each([undefined, 23])(
		'uses original line %s before the marker line when the current line is absent',
		originalLine => {
			const thread = botThread({ line: undefined, originalLine })
			expect(toThreadFinding(thread).line).toBe(
				originalLine ?? thread.marker.line
			)
		}
	)
})

describe('getRotated', () => {
	test.each([0, 1, MAX_RECHECKS])(
		'keeps %i items in order at any rotation',
		length => {
			const items = Array.from({ length }, (_, index) => ({ id: index }))
			expect(getRotated(items, 5)).toEqual(items)
			expect(getRotated(items, 5)).not.toBe(items)
		}
	)
	test.each([0, 1, 2, 3])(
		'starts a longer list at rotation %i and wraps without dropping items',
		rotation => {
			const items = Array.from({ length: MAX_RECHECKS + 2 }, (_, index) => ({
				id: index,
			}))
			const original = [...items]
			const start = (rotation * MAX_RECHECKS) % items.length
			const rotated = getRotated(items, rotation)
			expect(rotated).toEqual([...items.slice(start), ...items.slice(0, start)])
			expect(rotated[0]).toBe(items[start])
			expect(items).toEqual(original)
		}
	)
})
