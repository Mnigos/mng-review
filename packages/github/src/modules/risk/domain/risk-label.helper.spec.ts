import { DEFAULT_RISK_LABELS } from '@mng-review/domain'
import { RISK_HEAD } from '../../../shared/mocks/github-status-fake.helper'
import {
	APP_MODE_IDENTITIES,
	APP_IDENTITY,
} from '../../../shared/mocks/publish-test.helper'
import { getPersonLabels, planRiskLabels } from './risk-label.helper'

const LABELS = DEFAULT_RISK_LABELS

describe('risk labels', () => {
	test('sets exactly the configured label and leaves unrelated labels and Blocked alone', () => {
		expect(
			planRiskLabels(
				{
					labels: LABELS,
					current: [LABELS.low, LABELS.high, 'Blocked', 'storage'],
					personSet: new Set(),
				},
				'medium'
			)
		).toEqual({ add: LABELS.medium, remove: [LABELS.low, LABELS.high] })
	})
	test('keeps a higher person label and adds no lower label', () => {
		expect(
			planRiskLabels(
				{
					labels: LABELS,
					current: [LABELS.high, LABELS.low, 'Blocked'],
					personSet: new Set([LABELS.high.toLowerCase()]),
				},
				'low'
			)
		).toEqual({ remove: [LABELS.low] })
	})
	test('revocation removes only bot risk labels', () => {
		expect(
			planRiskLabels(
				{
					labels: LABELS,
					current: [LABELS.high, LABELS.low, 'Blocked', 'storage'],
					personSet: new Set([LABELS.high.toLowerCase()]),
				},
				undefined
			)
		).toEqual({ remove: [LABELS.low] })
	})
	test('only labels a person added after the current head arrived count', () => {
		const actor = { __typename: 'User', login: 'writer' }
		expect(
			getPersonLabels(
				[
					{ __typename: 'LabeledEvent', label: { name: LABELS.medium }, actor },
					{
						__typename: 'HeadRefForcePushedEvent',
						afterCommit: { oid: RISK_HEAD },
					},
					{ __typename: 'LabeledEvent', label: { name: LABELS.high }, actor },
					{
						__typename: 'LabeledEvent',
						label: { name: LABELS.low },
						actor: { __typename: 'Bot', login: APP_IDENTITY.login },
					},
				],
				RISK_HEAD,
				APP_MODE_IDENTITIES
			)
		).toEqual(new Set([LABELS.high.toLowerCase()]))
	})
	test('a later removal or bot add clears a person label attribution', () => {
		const actor = { __typename: 'User', login: 'writer' }
		expect(
			getPersonLabels(
				[
					{ __typename: 'PullRequestCommit', commit: { oid: RISK_HEAD } },
					{ __typename: 'LabeledEvent', label: { name: LABELS.high }, actor },
					{ __typename: 'UnlabeledEvent', label: { name: LABELS.high }, actor },
				],
				RISK_HEAD,
				APP_MODE_IDENTITIES
			)
		).toEqual(new Set())
	})
	test('a head the timeline does not show leaves the setters unknown', () => {
		expect(
			getPersonLabels(
				[
					{
						__typename: 'LabeledEvent',
						label: { name: LABELS.high },
						actor: { __typename: 'User', login: 'writer' },
					},
				],
				RISK_HEAD,
				APP_MODE_IDENTITIES
			)
		).toBeUndefined()
	})
})
