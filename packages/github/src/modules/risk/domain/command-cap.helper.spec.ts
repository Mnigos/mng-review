import { toAnsweredComment } from './answer.helper'
import { getCountedReviews, isOverCap } from './command-cap.helper'

const COMMAND = {
	id: 1,
	at: '2026-01-01T12:00:00Z',
	body: '@mng-review review',
	review: true,
	actedOn: true,
} as const

describe('review command cap', () => {
	test('counts only acted-on review commands, excluding current denials', () => {
		const comments = [
			COMMAND,
			{ ...COMMAND, id: 2, actedOn: false },
			{ ...COMMAND, id: 3, review: false },
			{ ...COMMAND, id: 4 },
			{ ...COMMAND, id: 5 },
		]
		expect(
			getCountedReviews(comments, [
				{
					run: 9,
					kind: 'deny',
					ids: [toAnsweredComment({ ...COMMAND, id: 4 })],
				},
				{
					run: 10,
					kind: 'cap',
					ids: [toAnsweredComment({ ...COMMAND, id: 5 })],
				},
			]).map(comment => comment.id)
		).toEqual([1, 5])
	})
	test('an edit makes a previously denied command count again', () => {
		expect(
			getCountedReviews(
				[{ ...COMMAND, body: '@mng-review review deep' }],
				[{ run: 9, kind: 'deny', ids: [toAnsweredComment(COMMAND)] }]
			)
		).toHaveLength(1)
	})
	test('allows the first three and refuses the fourth including itself', () => {
		const counted = [1, 2, 3, 4].map(id => ({ id }))
		expect(counted.map(comment => isOverCap(counted, comment.id, 3))).toEqual([
			false,
			false,
			false,
			true,
		])
	})
})
