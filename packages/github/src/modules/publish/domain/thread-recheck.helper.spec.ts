import { botThread, bug } from '../../../shared/mocks/publish-test.helper'
import { getRecheckCandidates, toThreadFinding } from './thread-recheck.helper'

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
	test.each(['bug', 'unverified', 'nit'] as const)(
		'a matching published %s prevents rechecking',
		kind => {
			expect(
				getRecheckCandidates([botThread()], [{ finding: bug(), kind }], HEAD)
			).toEqual([])
		}
	)
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
