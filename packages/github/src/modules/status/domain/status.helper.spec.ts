import {
	toCommitStatus,
	toHeldStatus,
	toIncompleteDescription,
	toIncompleteStatus,
	toSweptStatus,
	UNFINISHED_NOTE,
} from './status.helper'

describe('toCommitStatus', () => {
	test.each([
		['ready', 0, true, 'success'],
		['ready', 2, true, 'failure'],
		['needs fixes', 2, true, 'failure'],
		['needs fixes', 0, true, 'success'],
		['needs owner', 0, true, 'failure'],
		['incomplete', 0, false, 'error'],
		['ready', 0, false, 'error'],
		['ready', 2, false, 'failure'],
		['needs fixes', 2, false, 'failure'],
		['needs owner', 0, false, 'failure'],
	] as const)(
		'%s with %i bugs, finished=%s gives %s',
		(verdict, bugs, finished, state) => {
			const status = toCommitStatus(verdict, bugs, finished)
			expect(status.state).toBe(state)
			expect(status.description.includes(UNFINISHED_NOTE)).toBe(!finished)
			expect(status.description.length).toBeLessThanOrEqual(140)
		}
	)
})

describe('toSweptStatus', () => {
	test('an unfinished marker repairs a success overwritten after an unfinished run', () => {
		expect(toSweptStatus(toCommitStatus('ready', 0, true), 0, false)).toEqual(
			toCommitStatus('ready', 0, false)
		)
	})
	test('a finished marker overrides both a previous error and its unfinished note', () => {
		expect(toSweptStatus(toCommitStatus('ready', 0, false), 0, true)).toEqual(
			toCommitStatus('ready', 0, true)
		)
	})
	test('open bugs keep the unfinished note when the marker says the run did not finish', () => {
		expect(
			toSweptStatus(toCommitStatus('needs fixes', 2, true), 1, false)
		).toEqual(toCommitStatus('needs fixes', 1, false))
	})
	test.each(['success', 'failure', 'error', 'pending'])(
		'open bugs turn %s into failure and preserve whether it finished',
		state => {
			const next = toSweptStatus({ state, description: null }, 2)
			expect(next?.state).toBe('failure')
			expect(next?.description.includes(UNFINISHED_NOTE)).toBe(
				state === 'error'
			)
		}
	)
	test('the last resolved bug turns a finished failure into success', () => {
		expect(
			toSweptStatus({ state: 'failure', description: '1 open bug' }, 0)
		).toEqual(toCommitStatus('ready', 0, true))
	})
	test.each(['failure', 'pending', 'success', 'error'])(
		'%s with the unfinished note stays error after the last bug resolves',
		state => {
			expect(
				toSweptStatus(
					{ state, description: `1 open bug; ${UNFINISHED_NOTE}` },
					0
				)
			).toEqual(toCommitStatus('ready', 0, false))
		}
	)
	test('a previous error without the note is normalized to an unfinished error', () => {
		expect(
			toSweptStatus({ state: 'error', description: 'offline' }, 0)
		).toEqual(toCommitStatus('ready', 0, false))
	})
	test('open bugs keep the unfinished note from a failure', () => {
		expect(
			toSweptStatus(
				{ state: 'failure', description: `2 open bugs; ${UNFINISHED_NOTE}` },
				1
			)
		).toEqual(toCommitStatus('needs fixes', 1, false))
	})
	for (const finished of [true, false])
		test.each([0, 2])(
			`no update when state and description agree with %i bugs, finished=${finished}`,
			bugs => {
				const prior = toCommitStatus(
					bugs ? 'needs fixes' : 'ready',
					bugs,
					finished
				)
				expect(toSweptStatus(prior, bugs)).toBeUndefined()
			}
		)
	test('updates a stale description even when the state stays the same', () => {
		expect(
			toSweptStatus({ state: 'failure', description: '2 open bugs' }, 1)
		).toEqual(toCommitStatus('needs fixes', 1, true))
	})
})

describe('toIncompleteStatus', () => {
	const lists = ['review threads', 'reviews'] as const
	const pending = {
		state: 'pending',
		description: toIncompleteDescription(lists),
	} as const
	for (const [name, previous] of [
		['failure', { state: 'failure', description: '1 open bug thread(s)' }],
		['error', { state: 'error', description: 'no open bug thread' }],
		['pending', pending],
	] as const)
		test(`a success over a ${name} status writes nothing`, () => {
			expect(
				toIncompleteStatus(toCommitStatus('ready', 0, true), previous, lists)
			).toBeUndefined()
		})
	for (const [name, previous] of [
		['a head with no status', undefined],
		['a success', toCommitStatus('ready', 0, true)],
	] as const)
		test(`a success over ${name} becomes pending with the reason`, () => {
			expect(
				toIncompleteStatus(toCommitStatus('ready', 0, true), previous, lists)
			).toEqual(pending)
		})
	for (const [name, next] of [
		['needs fixes', toCommitStatus('needs fixes', 1, true)],
		['needs owner', toCommitStatus('needs owner', 0, true)],
		['unfinished', toCommitStatus('ready', 0, false)],
	] as const)
		test(`a ${name} ${next.state} status writes as it is`, () => {
			const success = toCommitStatus('ready', 0, true)
			expect(toIncompleteStatus(next, success, lists)).toBe(next)
			expect(toIncompleteStatus(next, undefined, lists)).toBe(next)
		})
})

describe('toIncompleteDescription', () => {
	test('names every list GitHub left an entry out of, under 140 characters', () => {
		const description = toIncompleteDescription([
			'review threads',
			'thread comments',
			'conversation comments',
			'reviews',
		])
		expect(description).toContain(
			'review threads, thread comments, conversation comments, reviews'
		)
		expect(description.length).toBeLessThanOrEqual(140)
	})
})

describe('toHeldStatus', () => {
	const lists = ['review threads'] as const
	test('a success after an incomplete read becomes pending with the reason', () => {
		expect(toHeldStatus(toCommitStatus('ready', 0, true), lists)).toEqual({
			state: 'pending',
			description: toIncompleteDescription(lists),
		})
	})
	test('a success after complete reads stays', () => {
		expect(toHeldStatus(toCommitStatus('ready', 0, true), [])).toBeUndefined()
	})
	for (const status of [
		toCommitStatus('needs fixes', 1, true),
		toCommitStatus('ready', 0, false),
		{ state: 'pending', description: null },
	] as const)
		test(`a ${status.state} status stays after an incomplete read`, () => {
			expect(toHeldStatus(status, lists)).toBeUndefined()
		})
})
