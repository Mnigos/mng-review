import { Effect, Layer } from 'effect'
import {
	type BotIdentity,
	GITHUB_ACTIONS_IDENTITY,
} from '../../platform/bot-identity.helper'
import { RECENT_COMMENTS } from '../../platform/github-api.constants'
import type {
	IssueComment,
	PullRequest,
	PullRequestComment,
	PullRequestReview,
	ReviewThread,
	ThreadComment,
} from '../../platform/github-api.schema'
import {
	GitHubApiService,
	type ReviewCommentInput,
} from '../../platform/github-api.service'
import {
	GitHubReviewService,
	REVIEW_STATE_BY_EVENT,
} from '../../platform/github-review.service'
import type { GitHubApiError } from '../../platform/github.errors'
import { getBasePermission } from './collaborator-role.helper'
import type { ApiWrite } from './github-api-fake.types'

/** An open same-repository pull request with full commits, as a command run reads it again. */
export const COMMAND_PULL_REQUEST = {
	number: 17,
	state: 'open',
	title: 'Review the change',
	body: 'Change details',
	draft: false,
	user: { login: 'author-a' },
	labels: [{ name: 'storage' }],
	base: {
		sha: 'a'.repeat(40),
		ref: 'main',
		repo: { full_name: 'example/project' },
	},
	head: { sha: 'b'.repeat(40), repo: { full_name: 'example/project' } },
} as const satisfies PullRequest

/** The command comment the fake answers with by default. */
export const COMMAND_COMMENT = {
	id: 23,
	body: '@mng-review review',
	user: { login: 'author-a', type: 'User' },
} as const satisfies IssueComment

/** Failure injection for a create GitHub stored before its response was lost. */
export interface GitHubApiFakeOptions {
	readonly storeFailedCreates?: boolean
}

/** In-memory GitHub with call recording and explicit per-operation failures, never an HTTP client. */
export function githubApiFake(
	identity: BotIdentity = GITHUB_ACTIONS_IDENTITY,
	options: GitHubApiFakeOptions = {}
) {
	const threads: ReviewThread[] = []
	const threadSnapshots: ReviewThread[][] = []
	const comments: PullRequestComment[] = []
	const reviews: PullRequestReview[] = []
	const reviewSnapshots: PullRequestReview[][] = []
	const reviewReads: number[] = []
	const reviewCommitReads: (boolean | undefined)[] = []
	const writes: ApiWrite[] = []
	const commentReads: number[] = []
	const commentSnapshots: PullRequestComment[][] = []
	const reads: string[] = []
	/** The pull request each read returns in turn, before `command.pullRequest`. */
	const pullRequestSnapshots: PullRequest[] = []
	const command: {
		pullRequest: PullRequest
		comment: IssueComment
		role: string
		permission: string | undefined
	} = {
		pullRequest: structuredClone(COMMAND_PULL_REQUEST),
		comment: structuredClone(COMMAND_COMMENT),
		role: 'admin',
		permission: undefined,
	}
	const failures = {
		review: [] as GitHubApiError[],
		comment: [] as GitHubApiError[],
		create: [] as GitHubApiError[],
		update: [] as GitHubApiError[],
		updateReview: [] as GitHubApiError[],
		dismissReview: [] as GitHubApiError[],
		/** `undefined` lets that call succeed, so a later one can fail. */
		listReviews: [] as (GitHubApiError | undefined)[],
		delete: [] as GitHubApiError[],
		minimize: [] as GitHubApiError[],
		reply: [] as GitHubApiError[],
		resolve: [] as GitHubApiError[],
		/** `undefined` lets that call succeed, so a later one can fail. */
		listThreads: [] as (GitHubApiError | undefined)[],
		listComments: [] as GitHubApiError[],
		/** `undefined` lets that call succeed, so a later one can fail. */
		getPullRequest: [] as (GitHubApiError | undefined)[],
		getIssueComment: [] as GitHubApiError[],
		getCollaboratorRole: [] as GitHubApiError[],
		listThreadComments: [] as GitHubApiError[],
		label: [] as GitHubApiError[],
		unlabel: [] as GitHubApiError[],
	}
	/** Every comment of a thread by id; unset, a thread shows its first and latest comment. */
	const threadComments = new Map<string, ThreadComment[]>()
	const author = { __typename: 'Bot', login: identity.login }
	const addThread = (input: ReviewCommentInput) => {
		threads.push({
			id: `thread-${threads.length}`,
			isResolved: false,
			isOutdated: false,
			path: input.path,
			line: input.line ?? null,
			originalLine: input.line ?? null,
			subjectType: input.line === undefined ? 'FILE' : 'LINE',
			comments: {
				totalCount: 1,
				nodes: [
					{
						databaseId: threads.length + 1,
						body: input.body,
						author,
						editor: null,
						originalCommit: { oid: input.commitId },
					},
				],
			},
		})
	}
	const threadReads: number[] = []
	const listReviewThreads = (pullNumber: number) =>
		Effect.gen(function* () {
			threadReads.push(pullNumber)
			const error = failures.listThreads.shift()
			if (error) return yield* error
			return threadSnapshots.shift() ?? [...threads]
		})
	const api = Layer.succeed(GitHubApiService, {
		replyToThread: (id, body) =>
			Effect.gen(function* () {
				writes.push({ method: 'reply', id, body })
				const error = failures.reply.shift()
				if (error) return yield* error
				const index = threads.findIndex(thread => thread.id === id)
				const thread = threads[index]
				const earlier =
					thread && thread.comments.totalCount > 1
						? (thread.latest?.nodes ?? [])
						: []
				if (thread)
					threads[index] = {
						...thread,
						latest: {
							nodes: [
								...earlier,
								{
									databaseId: writes.length,
									body,
									author,
									editor: null,
									originalCommit: null,
								},
							].slice(-RECENT_COMMENTS),
						},
						comments: {
							...thread.comments,
							totalCount: thread.comments.totalCount + 1,
						},
					}
				return undefined
			}),
		resolveThread: id =>
			Effect.gen(function* () {
				writes.push({ method: 'resolve', id })
				const error = failures.resolve.shift()
				if (error) return yield* error
				const index = threads.findIndex(thread => thread.id === id)
				const thread = threads[index]
				if (thread) threads[index] = { ...thread, isResolved: true }
				return undefined
			}),
		listReviewThreads,
		listThreadComments: id =>
			Effect.gen(function* () {
				reads.push(`listThreadComments:${id}`)
				const error = failures.listThreadComments.shift()
				if (error) return yield* error
				const thread = threads.find(entry => entry.id === id)
				const latest =
					thread && thread.comments.totalCount > 1
						? (thread.latest?.nodes ?? [])
						: []
				return (
					threadComments.get(id) ?? [
						...(thread?.comments.nodes ?? []),
						...latest,
					]
				)
			}),
		addLabel: (pullNumber, name) =>
			Effect.gen(function* () {
				writes.push({ method: 'label', pullNumber, name })
				const error = failures.label.shift()
				if (error) return yield* error
				return undefined
			}),
		removeLabel: (pullNumber, name) =>
			Effect.gen(function* () {
				writes.push({ method: 'unlabel', pullNumber, name })
				const error = failures.unlabel.shift()
				if (error) return yield* error
				return undefined
			}),
		listComments: pullNumber =>
			Effect.gen(function* () {
				commentReads.push(pullNumber)
				const error = failures.listComments.shift()
				if (error) return yield* error
				return commentSnapshots.shift() ?? [...comments]
			}),
		getPullRequest: pullNumber =>
			Effect.gen(function* () {
				reads.push(`getPullRequest:${pullNumber}`)
				const error = failures.getPullRequest.shift()
				if (error) return yield* error
				return pullRequestSnapshots.shift() ?? command.pullRequest
			}),
		getIssueComment: id =>
			Effect.gen(function* () {
				reads.push(`getIssueComment:${id}`)
				const error = failures.getIssueComment.shift()
				if (error) return yield* error
				return command.comment
			}),
		getCollaboratorRole: login =>
			Effect.gen(function* () {
				reads.push(`getCollaboratorRole:${login}`)
				const error = failures.getCollaboratorRole.shift()
				if (error) return yield* error
				return {
					role_name: command.role,
					permission: command.permission ?? getBasePermission(command.role),
				}
			}),
		createReviewComment: (pullNumber, input) =>
			Effect.gen(function* () {
				writes.push({ method: 'comment', pullNumber, input })
				const error = failures.comment.shift()
				if (error) return yield* error
				addThread(input)
				return writes.length
			}),
		createIssueComment: (pullNumber, body) =>
			Effect.gen(function* () {
				writes.push({ method: 'create', pullNumber, body })
				const error = failures.create.shift()
				if (error && !options.storeFailedCreates) return yield* error
				const id = writes.length
				comments.push({
					id: `comment-${id}`,
					databaseId: id,
					isMinimized: false,
					body,
					author,
					editor: null,
				})
				if (error) return yield* error
				return id
			}),
		deleteIssueComment: id =>
			Effect.gen(function* () {
				writes.push({ method: 'delete', id })
				const error = failures.delete.shift()
				if (error) return yield* error
				const index = comments.findIndex(comment => comment.databaseId === id)
				if (index !== -1) comments.splice(index, 1)
				return undefined
			}),
		minimizeComment: id =>
			Effect.gen(function* () {
				writes.push({ method: 'minimize', id })
				const error = failures.minimize.shift()
				if (error) return yield* error
				const index = comments.findIndex(comment => comment.id === id)
				const existing = comments[index]
				if (existing) comments[index] = { ...existing, isMinimized: true }
				const reviewIndex = reviews.findIndex(review => review.id === id)
				const review = reviews[reviewIndex]
				if (review) reviews[reviewIndex] = { ...review, isMinimized: true }
				return undefined
			}),
		updateIssueComment: (id, body) =>
			Effect.gen(function* () {
				writes.push({ method: 'update', id, body })
				const error = failures.update.shift()
				if (error) return yield* error
				const index = comments.findIndex(comment => comment.databaseId === id)
				const existing = comments[index]
				if (existing) comments[index] = { ...existing, body }
				return undefined
			}),
	})
	const reviewApi = Layer.succeed(GitHubReviewService, {
		listReviews: (pullNumber, withCommits) =>
			Effect.gen(function* () {
				reviewReads.push(pullNumber)
				reviewCommitReads.push(withCommits)
				const error = failures.listReviews.shift()
				if (error) return yield* error
				return reviewSnapshots.shift() ?? [...reviews]
			}),
		createReview: (pullNumber, input) =>
			Effect.gen(function* () {
				writes.push({ method: 'review', pullNumber, input })
				const error = failures.review.shift()
				if (error && !options.storeFailedCreates) return yield* error
				const id = writes.length
				for (const comment of input.comments)
					addThread({ ...comment, commitId: input.commitId })
				reviews.push({
					id: `review-${id}`,
					databaseId: id,
					state: REVIEW_STATE_BY_EVENT[input.event],
					isMinimized: false,
					body: input.body,
					author,
					editor: null,
					commit: { oid: input.commitId },
				})
				if (error) return yield* error
				return id
			}),
		dismissReview: (_pullNumber, id, body) =>
			Effect.gen(function* () {
				writes.push({ method: 'dismissReview', id, body })
				const error = failures.dismissReview.shift()
				if (error) return yield* error
				const index = reviews.findIndex(review => review.databaseId === id)
				const existing = reviews[index]
				if (existing) reviews[index] = { ...existing, state: 'DISMISSED' }
				return undefined
			}),
		updateReview: (_pullNumber, id, body) =>
			Effect.gen(function* () {
				writes.push({ method: 'updateReview', id, body })
				const error = failures.updateReview.shift()
				if (error) return yield* error
				const index = reviews.findIndex(review => review.databaseId === id)
				const existing = reviews[index]
				if (existing) reviews[index] = { ...existing, body }
				return undefined
			}),
	})
	return {
		api: Layer.mergeAll(api, reviewApi),
		reviews,
		reviewSnapshots,
		reviewReads,
		reviewCommitReads,
		threads,
		comments,
		writes,
		failures,
		threadReads,
		threadSnapshots,
		commentReads,
		commentSnapshots,
		reads,
		pullRequestSnapshots,
		command,
		threadComments,
	}
}
