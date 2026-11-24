import { toRiskDescription } from '@mng-review/domain'
import {
	GITHUB_ACTIONS_IDENTITY,
	toBotIdentity,
} from '../../../platform/bot-identity.helper'
import {
	RISK_HEAD,
	RISK_DESCRIPTION,
	riskStatus,
} from '../../../shared/mocks/github-status-fake.helper'
import {
	APP_IDENTITY,
	appSummary,
	summaryReview,
	SUMMARY_MARKER,
} from '../../../shared/mocks/publish-test.helper'
import {
	getHeldOwners,
	getTimelineHeads,
	toAppRiskStatuses,
	getNewestStatus,
	getStatusesHighest,
	hasAppHistory,
} from './risk-history.helper'

const PREVIOUS_APP = toBotIdentity('old-review')
const APP_ONLY = { current: APP_IDENTITY, identities: [APP_IDENTITY] } as const
const SWITCHED = {
	current: APP_IDENTITY,
	identities: [APP_IDENTITY, PREVIOUS_APP],
} as const

describe('risk history', () => {
	test('includes commits, both force-push sides and the current head once', () => {
		expect(
			getTimelineHeads(
				[
					{ __typename: 'PullRequestCommit', commit: { oid: 'old' } },
					{
						__typename: 'HeadRefForcePushedEvent',
						beforeCommit: { oid: 'before' },
						afterCommit: { oid: 'after' },
					},
					{ __typename: 'PullRequestCommit', commit: { oid: 'old' } },
					{ __typename: 'LabeledEvent', label: { name: 'Low risk' } },
				],
				RISK_HEAD
			)
		).toEqual(['old', 'before', 'after', RISK_HEAD])
	})
	for (const item of [
		{ __typename: 'PullRequestCommit', commit: null },
		{ __typename: 'PullRequestCommit' },
		{
			__typename: 'HeadRefForcePushedEvent',
			beforeCommit: null,
			afterCommit: { oid: 'after' },
		},
		{
			__typename: 'HeadRefForcePushedEvent',
			beforeCommit: { oid: 'before' },
			afterCommit: null,
		},
	])
		test(`a ${item.__typename} without its commit fails the read`, () => {
			expect(getTimelineHeads([item], RISK_HEAD)).toBeUndefined()
		})
	test('isolates two pull requests sharing a head, and ignores other creators and malformed descriptions', () => {
		const statuses = [
			riskStatus({ id: 1 }, { level: 'medium' }),
			riskStatus({ id: 9 }, { pr: 18, level: 'high' }),
			riskStatus(
				{ id: 10, creator: { login: 'other[bot]', type: 'Bot' } },
				{ level: 'high' }
			),
			riskStatus({ id: 11, description: 'v1 pr=17 high' }),
			riskStatus({ id: 12, context: 'other' }),
			riskStatus({
				id: 13,
				creator: { login: APP_IDENTITY.restLogin, type: 'User' },
			}),
		]
		const own = toAppRiskStatuses(RISK_HEAD, statuses, APP_ONLY, 17)
		expect(own.map(status => status.id)).toEqual([1])
		expect(getStatusesHighest(own)).toBe('medium')
		expect(getNewestStatus(own, RISK_HEAD)?.id).toBe(1)
		expect(
			toAppRiskStatuses(RISK_HEAD, statuses, APP_ONLY, 18).map(
				status => status.id
			)
		).toEqual([9])
	})
	test('holds an older High error even after a newer Low grant', () => {
		const statuses = toAppRiskStatuses(
			RISK_HEAD,
			[
				riskStatus({ id: 2, state: 'success' }),
				riskStatus({ id: 1 }, { level: 'high' }),
			],
			APP_ONLY,
			17
		)
		expect(getStatusesHighest(statuses)).toBe('high')
		expect(getNewestStatus(statuses, RISK_HEAD)?.id).toBe(2)
	})
	for (const state of ['success', 'failure', 'error'])
		test(`${state} has the defined history meaning`, () => {
			expect(
				hasAppHistory(
					toAppRiskStatuses(RISK_HEAD, [riskStatus({ state })], APP_ONLY, 17),
					[],
					APP_ONLY.identities
				)
			).toBe(state !== 'error')
		})
	test('only an app-authored rating review counts as review history', () => {
		const marked = summaryReview(
			{ ...SUMMARY_MARKER, risk: 'low' },
			{ author: appSummary().author }
		)
		expect(hasAppHistory([], [marked], APP_ONLY.identities)).toBeTruthy()
		expect(
			hasAppHistory(
				[],
				[summaryReview(SUMMARY_MARKER, { author: appSummary().author })],
				APP_ONLY.identities
			)
		).toBe(false)
		expect(
			hasAppHistory(
				[],
				[{ ...marked, editor: { __typename: 'User', login: 'writer' } }],
				APP_ONLY.identities
			)
		).toBe(false)
		expect(toRiskDescription(RISK_DESCRIPTION)).toContain('pr=17')
	})
	test('a previous app counts for the held level and history but never for the nonce', () => {
		const previous = {
			login: PREVIOUS_APP.restLogin,
			type: 'Bot',
		}
		const statuses = toAppRiskStatuses(
			RISK_HEAD,
			[
				riskStatus(
					{ id: 3, state: 'failure', creator: previous },
					{
						level: 'high',
						nonce: 'f'.repeat(16),
					}
				),
				riskStatus({ id: 2 }),
			],
			SWITCHED,
			17
		)
		expect(
			statuses.map(status => ({ id: status.id, current: status.current }))
		).toEqual([
			{ id: 3, current: false },
			{ id: 2, current: true },
		])
		expect(getStatusesHighest(statuses)).toBe('high')
		expect(getNewestStatus(statuses, RISK_HEAD)?.id).toBe(2)
		expect(
			hasAppHistory(statuses.slice(0, 1), [], SWITCHED.identities)
		).toBeTruthy()
		expect(
			hasAppHistory(
				[],
				[
					summaryReview(
						{ ...SUMMARY_MARKER, risk: 'low' },
						{ author: { __typename: 'Bot', login: PREVIOUS_APP.login } }
					),
				],
				SWITCHED.identities
			)
		).toBeTruthy()
	})
	test('the job token never counts for the held level, whatever the owned list says', () => {
		expect(
			getHeldOwners({
				current: APP_IDENTITY,
				identities: [APP_IDENTITY, GITHUB_ACTIONS_IDENTITY, PREVIOUS_APP],
			})
		).toEqual(SWITCHED)
		expect(
			toAppRiskStatuses(
				RISK_HEAD,
				[
					riskStatus(
						{
							id: 4,
							state: 'failure',
							creator: {
								login: GITHUB_ACTIONS_IDENTITY.restLogin,
								type: 'Bot',
							},
						},
						{ level: 'high' }
					),
				],
				getHeldOwners({
					current: APP_IDENTITY,
					identities: [APP_IDENTITY, GITHUB_ACTIONS_IDENTITY],
				}),
				17
			)
		).toEqual([])
	})
})
