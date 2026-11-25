import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { githubApiFake } from '../shared/mocks/github-api-fake.helper'
import { githubStatusFake } from '../shared/mocks/github-status-fake.helper'
import { APP_MODE_OWNED } from '../shared/mocks/publish-test.helper'
import { GitHubApiService } from './github-api.service'
import { GitHubReviewService } from './github-review.service'
import { GitHubStatusService } from './github-status.service'
import { withReadJournal } from './read-journal.context'
import { ReadJournalLayer } from './read-journal.layer'

/**
 * The writes of the three services, which the read journal passes through unrecorded. Every other
 * method is a read and must show up in the journal when called.
 */
const KNOWN_WRITES = [
	'addLabel',
	'removeLabel',
	'createReviewComment',
	'createIssueComment',
	'updateIssueComment',
	'deleteIssueComment',
	'minimizeComment',
	'replyToThread',
	'updateThreadComment',
	'resolveThread',
	'unresolveThread',
	'createReview',
	'dismissReview',
	'updateReview',
	'createCheckRun',
	'setStatus',
] as const

layer(APP_MODE_OWNED)('ReadJournalLayer', test => {
	test.effect(
		'records every method that is not a known write and no write',
		() =>
			Effect.gen(function* () {
				const api = githubApiFake()
				const status = githubStatusFake()
				const pass = Effect.gen(function* () {
					const github = yield* GitHubApiService
					const reviews = yield* GitHubReviewService
					const statuses = yield* GitHubStatusService
					yield* github.listReviewThreads(17)
					yield* github.listComments(17)
					yield* github.listThreadComments('thread')
					yield* github.getPullRequest(17)
					yield* github.getIssueComment(23)
					yield* github.getCollaboratorRole('owner')
					yield* reviews.listReviews(17, true)
					yield* statuses.getStatus('head')
					yield* statuses.listOpenPullRequests()
					yield* github.addLabel(17, 'label')
					yield* statuses.setStatus({
						sha: 'head',
						state: 'success',
						description: 'no open bug thread',
					})
					return [
						...Object.keys(github),
						...Object.keys(reviews),
						...Object.keys(statuses),
					]
				}).pipe(
					Effect.provide(
						ReadJournalLayer.pipe(
							Layer.provide(Layer.merge(api.api, status.layer))
						)
					)
				)
				const { value: methods, reads } = yield* withReadJournal(pass)
				const journaled = reads.map(read => read.split('"')[1] ?? '')
				expect(journaled).toEqual([
					'listReviewThreads',
					'listComments',
					'listThreadComments',
					'getPullRequest',
					'getIssueComment',
					'getCollaboratorRole',
					'listReviews',
					'getStatus',
					'listOpenPullRequests',
				])
				// A read added as a plain pass-through is neither a known write nor in the journal.
				expect(journaled.toSorted((a, b) => a.localeCompare(b))).toEqual(
					methods
						.filter(method => !KNOWN_WRITES.some(write => write === method))
						.toSorted((a, b) => a.localeCompare(b))
				)
				expect(KNOWN_WRITES.filter(write => !methods.includes(write))).toEqual(
					[]
				)
			})
	)
})
