import { Effect, Layer } from 'effect'
import { GITHUB_ACTIONS_IDENTITY } from '../../platform/bot-identity.helper'
import type {
	PullRequestComment,
	ReviewThread,
} from '../../platform/github-api.schema'
import {
	GitHubApiService,
	type ReviewInput,
	type ReviewCommentInput,
} from '../../platform/github-api.service'
import type { GitHubApiError } from '../../platform/github.errors'

export type ApiWrite =
	| {
			readonly method: 'review'
			readonly pullNumber: number
			readonly input: ReviewInput
	  }
	| {
			readonly method: 'comment'
			readonly pullNumber: number
			readonly input: ReviewCommentInput
	  }
	| {
			readonly method: 'create'
			readonly pullNumber: number
			readonly body: string
	  }
	| { readonly method: 'update'; readonly id: number; readonly body: string }
	| { readonly method: 'delete'; readonly id: number }
	| { readonly method: 'minimize'; readonly id: string }
	| { readonly method: 'reply'; readonly id: string; readonly body: string }
	| { readonly method: 'resolve'; readonly id: string }

/** In-memory GitHub with call recording and explicit per-operation failures, never an HTTP client. */
export function githubApiFake() {
	const threads: ReviewThread[] = []
	const comments: PullRequestComment[] = []
	const writes: ApiWrite[] = []
	const failures = {
		review: [] as GitHubApiError[],
		comment: [] as GitHubApiError[],
		create: [] as GitHubApiError[],
		update: [] as GitHubApiError[],
		delete: [] as GitHubApiError[],
		minimize: [] as GitHubApiError[],
		reply: [] as GitHubApiError[],
		resolve: [] as GitHubApiError[],
		listThreads: [] as GitHubApiError[],
		listComments: [] as GitHubApiError[],
	}
	const author = { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login }
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
			return [...threads]
		})
	const api = Layer.succeed(GitHubApiService, {
		replyToThread: (id, body) =>
			Effect.gen(function* () {
				writes.push({ method: 'reply', id, body })
				const error = failures.reply.shift()
				if (error) return yield* error
				const index = threads.findIndex(thread => thread.id === id)
				const thread = threads[index]
				if (thread)
					threads[index] = {
						...thread,
						latest: {
							nodes: [
								{
									databaseId: writes.length,
									body,
									author,
									editor: null,
									originalCommit: null,
								},
							],
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
		listComments: () =>
			Effect.gen(function* () {
				const error = failures.listComments.shift()
				if (error) return yield* error
				return [...comments]
			}),
		createReview: (pullNumber, input) =>
			Effect.gen(function* () {
				writes.push({ method: 'review', pullNumber, input })
				const error = failures.review.shift()
				if (error) return yield* error
				for (const comment of input.comments)
					addThread({ ...comment, commitId: input.commitId })
				return writes.length
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
				if (error) return yield* error
				const id = writes.length
				comments.push({
					id: `comment-${id}`,
					databaseId: id,
					isMinimized: false,
					body,
					author,
					editor: null,
				})
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
	return { api, threads, comments, writes, failures, threadReads }
}
