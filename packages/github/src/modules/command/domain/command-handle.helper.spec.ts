import { getCommandHandle } from './command-handle.helper'

describe('getCommandHandle', () => {
	test.each([
		{ appSlug: 'mng-review', handle: '' },
		{ appSlug: '', handle: 'mng-review' },
		{ appSlug: ' mng-review\t', handle: ' \t' },
		{ appSlug: ' \t', handle: '\t mng-review ' },
	])('chooses the only nonblank input %j', handles => {
		expect(getCommandHandle(handles)).toEqual({
			status: 'chosen',
			handle: 'mng-review',
		})
	})

	test.each([
		{ appSlug: 'mng-review', handle: 'review-helper' },
		{ appSlug: 'mng-review', handle: 'mng-review' },
		{ appSlug: '', handle: '' },
		{ appSlug: ' \t', handle: '\n ' },
	])('denies ambiguous or missing inputs %j', handles => {
		expect(getCommandHandle(handles)).toMatchObject({
			status: 'denied',
		})
	})

	for (const value of [
		'a b',
		'.*',
		'mng-review[bot]',
		'-review',
		'review-',
		'a'.repeat(40),
	])
		for (const field of ['appSlug', 'handle'])
			test(`denies invalid ${field} ${JSON.stringify(value)}`, () => {
				expect(
					getCommandHandle({ appSlug: '', handle: '', [field]: value })
				).toMatchObject({ status: 'denied' })
			})
})
