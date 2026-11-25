import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { GitHubReviewService } from '../../../platform/github-review.service'
import { provideListCompleteness } from '../../../platform/list-completeness.context'
import { githubApiFake } from '../../../shared/mocks/github-api-fake.helper'
import {
	APP_IDENTITY,
	APP_MODE_OWNED,
	SUMMARY_MARKER,
	summaryReview,
} from '../../../shared/mocks/publish-test.helper'
import {
	ReviewDismissService,
	ReviewDismissServiceLive,
} from './review-dismiss.service'

layer(APP_MODE_OWNED)('ReviewDismissService', test => {
	for (const nulls of [0, 1])
		test.effect(
			nulls === 0
				? 'a complete run dismisses the change request it just posted once a push outlived it'
				: 'an incomplete run keeps the change request it just posted once a push outlived it',
			() =>
				Effect.gen(function* () {
					const fake = githubApiFake(APP_IDENTITY)
					fake.reviews.push(
						summaryReview(SUMMARY_MARKER, {
							databaseId: 301,
							state: 'CHANGES_REQUESTED',
							commit: { oid: 'reviewed' },
							author: { __typename: 'Bot', login: APP_IDENTITY.login },
						})
					)
					fake.nullNodes.reviews = nulls
					const dismissal = yield* Effect.gen(function* () {
						// A lenient review read of the run, which lists `nulls` null nodes.
						yield* GitHubReviewService.use(service => service.listReviews(17))
						return yield* ReviewDismissService.use(service =>
							service.dismissStale(
								17,
								{ head: 'reviewed', current: 'pushed' },
								[],
								{
									id: 301,
									decision: {
										event: 'REQUEST_CHANGES',
										keep: false,
										clears: false,
									},
									review: { state: 'CHANGES_REQUESTED', commit: 'reviewed' },
									created: true,
								}
							)
						)
					}).pipe(
						Effect.provide(
							Layer.merge(
								ReviewDismissServiceLive.pipe(Layer.provide(fake.api)),
								fake.api
							)
						),
						provideListCompleteness(false)
					)
					expect(dismissal).toEqual(
						nulls === 0
							? { dismissed: 1, failed: 0, outlived: true }
							: { dismissed: 0, failed: 0, outlived: false }
					)
					expect(fake.reviews[0]?.state).toBe(
						nulls === 0 ? 'DISMISSED' : 'CHANGES_REQUESTED'
					)
				})
		)
})

/** A ready or blocking standing a write's state was decided on. */
function replyEvidence(verdict: 'ready' | 'needs fixes' | 'needs owner') {
	return {
		kind: 'reply',
		verdict,
		openBugs: verdict === 'needs fixes' ? 1 : 0,
		current: true,
		onHead: true,
		failed: false,
		authored: false,
	} as const
}

layer(APP_MODE_OWNED)('ReviewDismissService approval withdrawal', test => {
	for (const scenario of [
		{ name: 'needs fixes', verdict: 'needs fixes', nulls: 1, current: 'head' },
		{ name: 'needs owner', verdict: 'needs owner', nulls: 1, current: 'head' },
		{ name: 'ready', verdict: 'ready', nulls: 1, current: 'head' },
		{ name: 'complete', verdict: 'needs fixes', nulls: 0, current: 'head' },
		{ name: 'moved head', verdict: 'needs fixes', nulls: 1, current: 'pushed' },
	] as const)
		test.effect(
			`withdraws the current identity's approval of the head only for an incomplete blocking run on it: ${scenario.name}`,
			() =>
				Effect.gen(function* () {
					const fake = githubApiFake(APP_IDENTITY)
					const author = {
						__typename: 'Bot',
						login: APP_IDENTITY.login,
					} as const
					fake.reviews.push(
						summaryReview(SUMMARY_MARKER, {
							databaseId: 301,
							state: 'APPROVED',
							commit: { oid: scenario.current },
							author,
						}),
						// Another owned identity's approval is not the current identity's to withdraw here.
						summaryReview(SUMMARY_MARKER, {
							databaseId: 302,
							state: 'APPROVED',
							commit: { oid: scenario.current },
						})
					)
					fake.nullNodes.reviews = scenario.nulls
					const withdrawn =
						scenario.name === 'needs fixes' || scenario.name === 'needs owner'
					const dismissal = yield* Effect.gen(function* () {
						const reviews = yield* GitHubReviewService.use(service =>
							service.listReviews(17, true)
						)
						return yield* ReviewDismissService.use(service =>
							service.withdrawApprovals(
								17,
								{ head: 'head', current: scenario.current },
								reviews,
								replyEvidence(scenario.verdict)
							)
						)
					}).pipe(
						Effect.provide(
							Layer.merge(
								ReviewDismissServiceLive.pipe(Layer.provide(fake.api)),
								fake.api
							)
						),
						provideListCompleteness(false)
					)
					expect(dismissal).toEqual({
						dismissed: withdrawn ? 1 : 0,
						failed: 0,
					})
					expect(fake.reviews.map(review => review.state)).toEqual([
						withdrawn ? 'DISMISSED' : 'APPROVED',
						'APPROVED',
					])
				})
		)
})
