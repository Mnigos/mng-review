import { toCommitStatus, toSweptStatus } from './status.helper'

describe('toCommitStatus', () => {
	test.each([
		['ready', 0, 'success'],
		['needs fixes', 2, 'failure'],
		['needs owner', 0, 'failure'],
		['incomplete', 0, 'error'],
	] as const)('%s with %i bugs gives %s', (verdict, bugs, state) => {
		expect(toCommitStatus(verdict, bugs)).toMatchObject({ state })
		expect(
			toCommitStatus(verdict, bugs).description.length
		).toBeLessThanOrEqual(140)
	})
})

describe('toSweptStatus', () => {
	test.each(['success', 'failure', 'error', 'pending'])(
		'open bugs turn %s into failure',
		state => {
			expect(toSweptStatus({ state, description: null }, 2)).toEqual(
				toCommitStatus('needs fixes', 2)
			)
		}
	)
	test('the last resolved bug turns failure into success', () => {
		expect(
			toSweptStatus({ state: 'failure', description: '1 open bug' }, 0)
		).toEqual(toCommitStatus('ready', 0))
	})
	test('an incomplete run stays in error when no bug remains', () => {
		expect(
			toSweptStatus({ state: 'error', description: 'did not finish' }, 0)
		).toBeUndefined()
	})
	test.each([0, 2])(
		'no update is needed when state and description agree with %i bugs',
		bugs => {
			const prior = toCommitStatus(bugs ? 'needs fixes' : 'ready', bugs)
			expect(toSweptStatus(prior, bugs)).toBeUndefined()
		}
	)
	test('updates a stale description even when the state stays the same', () => {
		expect(
			toSweptStatus({ state: 'failure', description: '2 open bugs' }, 1)
		).toEqual(toCommitStatus('needs fixes', 1))
	})
})
