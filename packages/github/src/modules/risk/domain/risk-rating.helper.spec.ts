import { REPLY_ACTIONS } from '@mng-review/domain'
import { LOW_RATING } from '../../../shared/mocks/github-status-fake.helper'
import { EMPTY_RISK_MARKER } from './risk-marker.helper'
import {
	decideFullRating,
	decideThreadRating,
	getAnsweredOpenThreads,
} from './risk-rating.helper'
import { CLOSING_REPLY_ACTIONS } from './risk.constants'
import type { FullRatingFacts } from './risk.types'

const FACTS = {
	rating: LOW_RATING,
	floors: { hits: [], opaque: [] },
	routerRisky: false,
	confirmedBugs: [],
	threadsRead: true,
	marker: { status: 'trusted', id: 1, body: '', marker: EMPTY_RISK_MARKER },
	history: false,
	reused: undefined,
	held: 'none',
} as const satisfies FullRatingFacts

describe('risk rating decisions', () => {
	for (const reason of ['coverage-gap', 'rater-failed'] as const)
		test(`a stored tree/base level does not stand in for ${reason}`, () => {
			expect(
				decideFullRating({
					...FACTS,
					rating: {
						...LOW_RATING,
						status: 'unrated',
						reason,
						detail: 'missing',
					},
					reused: 'medium',
				})
			).toMatchObject({ status: 'unrated', reason, stepOne: 'none' })
		})
	test('a stored tree/base level takes the place of the model level', () => {
		expect(decideFullRating({ ...FACTS, reused: 'medium' })).toMatchObject({
			status: 'rated',
			level: 'medium',
		})
	})
	test('only answers that do not close a thread keep it open for the raise', () => {
		expect(
			getAnsweredOpenThreads(
				REPLY_ACTIONS.map(action => ({
					threadId: action,
					decision: { action },
				}))
			)
		).toEqual(
			REPLY_ACTIONS.filter(
				action => !CLOSING_REPLY_ACTIONS.some(closing => closing === action)
			)
		)
	})
	for (const severity of ['high', 'critical'])
		test(`${severity} confirmed threads raise full and thread runs to High`, () => {
			expect(
				decideFullRating({ ...FACTS, confirmedBugs: [severity] })
			).toMatchObject({ status: 'rated', level: 'high', stepOne: 'high' })
			expect(
				decideThreadRating({ ...FACTS, confirmedBugs: [severity] })
			).toMatchObject({ status: 'rated', level: 'high', stepOne: 'high' })
		})
	test('a thread run with no High or Critical confirmed bug writes nothing', () => {
		expect(decideThreadRating({ ...FACTS, confirmedBugs: ['medium'] })).toEqual(
			{ status: 'none' }
		)
	})
	test('an edited marker raises step one before its rewrite and never rates', () => {
		expect(
			decideFullRating({
				...FACTS,
				marker: {
					status: 'edited',
					id: 1,
					nodeId: 'comment-1',
					body: '',
					named: 'high',
				},
			})
		).toMatchObject({
			status: 'unrated',
			reason: 'marker-edited',
			stepOne: 'high',
		})
	})
	test('a missing marker after history cannot start a fresh rating', () => {
		expect(
			decideFullRating({ ...FACTS, marker: { status: 'none' }, history: true })
		).toMatchObject({ status: 'unrated', reason: 'history-without-marker' })
	})
	test('held High and router risky each supply their minimum', () => {
		expect(decideFullRating({ ...FACTS, held: 'high' })).toMatchObject({
			level: 'high',
			stepOne: 'high',
		})
		expect(decideFullRating({ ...FACTS, routerRisky: true })).toMatchObject({
			level: 'medium',
			stepOne: 'medium',
		})
	})
	test('an opaque binary stays unrated even when a stored level can be reused', () => {
		expect(
			decideFullRating({
				...FACTS,
				reused: 'high',
				floors: { hits: [], opaque: ['archive.bin'] },
			})
		).toMatchObject({ status: 'unrated', reason: 'opaque-binary' })
	})
})
