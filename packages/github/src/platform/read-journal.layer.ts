import { Effect, Layer } from 'effect'
import { GitHubApiService } from './github-api.service'
import { GitHubReviewService } from './github-review.service'
import { GitHubStatusService } from './github-status.service'
import { journaled } from './read-journal.context'

/**
 * Every read of `GitHubApiService` recorded in the open read journal; writes pass through. Every
 * method is named, so a method added to the service fails the typecheck here until it is handled.
 */
const JournaledApiLayer = Layer.effect(
	GitHubApiService,
	GitHubApiService.pipe(
		Effect.map((api): GitHubApiService['Service'] => ({
			addLabel: api.addLabel,
			removeLabel: api.removeLabel,
			createReviewComment: api.createReviewComment,
			createIssueComment: api.createIssueComment,
			updateIssueComment: api.updateIssueComment,
			deleteIssueComment: api.deleteIssueComment,
			minimizeComment: api.minimizeComment,
			replyToThread: api.replyToThread,
			updateThreadComment: api.updateThreadComment,
			resolveThread: api.resolveThread,
			unresolveThread: api.unresolveThread,
			listReviewThreads: pullNumber =>
				journaled(
					'listReviewThreads',
					[pullNumber],
					api.listReviewThreads(pullNumber)
				),
			listComments: pullNumber =>
				journaled('listComments', [pullNumber], api.listComments(pullNumber)),
			listThreadComments: threadId =>
				journaled(
					'listThreadComments',
					[threadId],
					api.listThreadComments(threadId)
				),
			getPullRequest: pullNumber =>
				journaled(
					'getPullRequest',
					[pullNumber],
					api.getPullRequest(pullNumber)
				),
			getIssueComment: commentId =>
				journaled(
					'getIssueComment',
					[commentId],
					api.getIssueComment(commentId)
				),
			getCollaboratorRole: login =>
				journaled(
					'getCollaboratorRole',
					[login],
					api.getCollaboratorRole(login)
				),
		}))
	)
)

/** Every read of `GitHubReviewService` recorded in the open read journal; writes pass through. */
const JournaledReviewLayer = Layer.effect(
	GitHubReviewService,
	GitHubReviewService.pipe(
		Effect.map((reviews): GitHubReviewService['Service'] => ({
			createReview: reviews.createReview,
			dismissReview: reviews.dismissReview,
			updateReview: reviews.updateReview,
			listReviews: (pullNumber, withCommits) =>
				journaled(
					'listReviews',
					[pullNumber, withCommits],
					reviews.listReviews(pullNumber, withCommits)
				),
		}))
	)
)

/** Every read of `GitHubStatusService` recorded in the open read journal; writes pass through. */
const JournaledStatusLayer = Layer.effect(
	GitHubStatusService,
	GitHubStatusService.pipe(
		Effect.map((statuses): GitHubStatusService['Service'] => ({
			createCheckRun: statuses.createCheckRun,
			setStatus: statuses.setStatus,
			getStatus: sha => journaled('getStatus', [sha], statuses.getStatus(sha)),
			listOpenPullRequests: options =>
				journaled(
					'listOpenPullRequests',
					[JSON.stringify(options)],
					statuses.listOpenPullRequests(options)
				),
		}))
	)
)

/**
 * The three GitHub services with every read recorded while a read journal is open
 * (`withReadJournal`), so a pass can be compared with a later one read for read. Outside a pass
 * they behave as the services they wrap.
 */
export const ReadJournalLayer = Layer.mergeAll(
	JournaledApiLayer,
	JournaledReviewLayer,
	JournaledStatusLayer
)
