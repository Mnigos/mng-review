import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import type { PullRequestComment } from '../../../platform/github-api.schema'
import {
	APP_IDENTITY,
	APP_MODE_IDENTITIES,
	appSummary,
	SUMMARY_MARKER,
} from '../../../shared/mocks/publish-test.helper'
import { getListedWaiting } from './summary-comment.helper'

describe('getListedWaiting', () => {
	test('unions every visible and hidden summary across current and previous identities', () => {
		expect(
			getListedWaiting(
				[
					appSummary({ ...SUMMARY_MARKER, needsOwner: ['current', 'shared'] }),
					appSummary(
						{ ...SUMMARY_MARKER, needsOwner: ['hidden', 'shared'] },
						{ isMinimized: true }
					),
					appSummary(
						{ ...SUMMARY_MARKER, needsOwner: ['previous', 'shared'] },
						{
							author: {
								__typename: 'Bot',
								login: GITHUB_ACTIONS_IDENTITY.login,
							},
						}
					),
					appSummary(
						{ ...SUMMARY_MARKER, needsOwner: ['previous-hidden'] },
						{
							isMinimized: true,
							author: {
								__typename: 'Bot',
								login: GITHUB_ACTIONS_IDENTITY.login,
							},
						}
					),
				],
				APP_MODE_IDENTITIES
			)
		).toEqual(['current', 'shared', 'hidden', 'previous', 'previous-hidden'])
	})
	test.each([
		{
			label: 'user pasting the marker',
			author: { __typename: 'User', login: APP_IDENTITY.login },
		},
		{ label: 'foreign bot', author: { __typename: 'Bot', login: 'other-bot' } },
		{ label: 'human editor', editor: { __typename: 'User', login: 'editor' } },
		{
			label: 'another owned bot editor',
			editor: { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login },
		},
		{ label: 'unmarked body', body: 'No summary marker' },
	] satisfies readonly SummaryTrustCase[])(
		'$label contributes no waiting ids',
		({ label: _label, ...overrides }) => {
			expect(
				getListedWaiting(
					[
						appSummary(
							{ ...SUMMARY_MARKER, needsOwner: ['forged'] },
							{ isMinimized: true, ...overrides }
						),
					],
					APP_MODE_IDENTITIES
				)
			).toEqual([])
		}
	)
	test('a self-edited owned summary still lists its threads', () => {
		expect(
			getListedWaiting(
				[
					appSummary(
						{ ...SUMMARY_MARKER, needsOwner: ['thread'] },
						{ editor: { __typename: 'Bot', login: APP_IDENTITY.login } }
					),
				],
				APP_MODE_IDENTITIES
			)
		).toEqual(['thread'])
	})
})

interface SummaryTrustCase extends Partial<PullRequestComment> {
	readonly label: string
}
