import { DEFAULT_PRESET } from '@mng-review/domain'
import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import type { ReviewEvent } from '../../../platform/github-review.service'
import { APP_IDENTITY } from '../../../shared/mocks/publish-test.helper'
import {
	canApprove,
	getReviewEvent,
	type ReviewEventInput,
} from './review-event.helper'

interface EventCase extends ReviewEventInput {
	readonly name: string
	readonly expected: ReviewEvent | undefined
}

const CASES = [
	{
		name: 'finished push',
		kind: 'review',
		verdict: 'ready',
		partial: false,
		findings: 0,
		approve: true,
		expected: 'APPROVE',
	},
	{
		name: 'finished full command',
		kind: 'review',
		verdict: 'ready',
		partial: false,
		findings: 0,
		approve: true,
		expected: 'APPROVE',
	},
	{
		name: 'single-agent command',
		kind: 'review',
		verdict: 'ready',
		partial: true,
		findings: 0,
		approve: true,
		expected: 'COMMENT',
	},
	{
		name: 'moved head',
		kind: 'review',
		verdict: 'ready',
		partial: true,
		findings: 0,
		approve: true,
		expected: 'COMMENT',
	},
	{
		name: 'unfinished review',
		kind: 'review',
		verdict: 'incomplete',
		partial: false,
		findings: 0,
		approve: true,
		expected: 'COMMENT',
	},
	{
		name: 'only unverified findings',
		kind: 'review',
		verdict: 'ready',
		partial: false,
		findings: 1,
		approve: true,
		expected: 'COMMENT',
	},
	{
		name: 'only nits',
		kind: 'review',
		verdict: 'ready',
		partial: false,
		findings: 2,
		approve: true,
		expected: 'COMMENT',
	},
	{
		name: 'only below-floor findings',
		kind: 'review',
		verdict: 'ready',
		partial: false,
		findings: 1,
		approve: true,
		expected: 'COMMENT',
	},
	{
		name: 'approval off',
		kind: 'review',
		verdict: 'ready',
		partial: false,
		findings: 0,
		approve: false,
		expected: 'COMMENT',
	},
	{
		name: 'confirmed bug',
		kind: 'review',
		verdict: 'needs fixes',
		partial: false,
		findings: 1,
		approve: true,
		expected: 'REQUEST_CHANGES',
	},
	{
		name: 'partial confirmed bug with approval off',
		kind: 'review',
		verdict: 'needs fixes',
		partial: true,
		findings: 1,
		approve: false,
		expected: 'REQUEST_CHANGES',
	},
	{
		name: 'owner needed on partial run',
		kind: 'review',
		verdict: 'needs owner',
		partial: true,
		findings: 0,
		approve: false,
		expected: 'REQUEST_CHANGES',
	},
	{
		name: 'ready reply-only run',
		kind: 'reply',
		verdict: 'ready',
		partial: false,
		findings: 0,
		approve: true,
		expected: 'APPROVE',
	},
	{
		name: 'reply-only needs fixes',
		kind: 'reply',
		verdict: 'needs fixes',
		partial: false,
		findings: 0,
		approve: false,
		expected: 'REQUEST_CHANGES',
	},
	{
		name: 'reply-only needs owner',
		kind: 'reply',
		verdict: 'needs owner',
		partial: false,
		findings: 0,
		approve: true,
		expected: 'REQUEST_CHANGES',
	},
	{
		name: 'reply-only open nit',
		kind: 'reply',
		verdict: 'ready',
		partial: false,
		findings: 1,
		approve: true,
		expected: 'COMMENT',
	},
	{
		name: 'reply-only open unverified thread',
		kind: 'reply',
		verdict: 'ready',
		partial: false,
		findings: 2,
		approve: true,
		expected: 'COMMENT',
	},
	{
		name: 'reply-only approval off',
		kind: 'reply',
		verdict: 'ready',
		partial: false,
		findings: 0,
		approve: false,
		expected: 'COMMENT',
	},
	{
		name: 'reply-only unfinished standing head',
		kind: 'reply',
		verdict: 'incomplete',
		partial: false,
		findings: 0,
		approve: true,
		expected: 'COMMENT',
	},
	{
		name: 'offline ready',
		kind: 'offline',
		verdict: 'ready',
		partial: false,
		findings: 0,
		approve: true,
		expected: undefined,
	},
	{
		name: 'offline needs fixes',
		kind: 'offline',
		verdict: 'needs fixes',
		partial: true,
		findings: 1,
		approve: false,
		expected: undefined,
	},
	{
		name: 'offline needs owner',
		kind: 'offline',
		verdict: 'needs owner',
		partial: false,
		findings: 0,
		approve: true,
		expected: undefined,
	},
	{
		name: 'offline incomplete',
		kind: 'offline',
		verdict: 'incomplete',
		partial: false,
		findings: 0,
		approve: true,
		expected: undefined,
	},
] as const satisfies readonly EventCase[]

test.each(CASES)('$name carries $expected', scenario => {
	expect(getReviewEvent(scenario)).toBe(scenario.expected)
})

for (const identity of [APP_IDENTITY, GITHUB_ACTIONS_IDENTITY])
	for (const mode of ['approve', 'preview'] as const)
		test(`${identity.login} with ${mode} decides approval before publishing`, () => {
			const approve = canApprove(
				{ verdict: { ...DEFAULT_PRESET.verdict, mode } },
				identity
			)
			expect(approve).toBe(mode === 'approve' && identity === APP_IDENTITY)
			expect(
				getReviewEvent({
					kind: 'review',
					verdict: 'ready',
					partial: false,
					findings: 0,
					approve,
				})
			).toBe(approve ? 'APPROVE' : 'COMMENT')
		})

test('the preset permits an app to approve a clean review by default', () => {
	expect(DEFAULT_PRESET.verdict.mode).toBe('approve')
	expect(canApprove(DEFAULT_PRESET, APP_IDENTITY)).toBe(true)
	expect(canApprove(DEFAULT_PRESET, GITHUB_ACTIONS_IDENTITY)).toBe(false)
})
