import { Effect, Layer } from 'effect'
import {
	type BotIdentity,
	GITHUB_ACTIONS_IDENTITY,
} from '../../platform/bot-identity.helper'
import type {
	IssueComment,
	PullRequest,
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
	const writes: ApiWrite[] = []
	const commentReads: number[] = []
	const commentSnapshots: PullRequestComment[][] = []
	const reads: string[] = []
	const command: {
		pullRequest: PullRequest
		comment: IssueComment
		role: string
	} = {
		pullRequest: structuredClone(COMMAND_PULL_REQUEST),
		comment: structuredClone(COMMAND_COMMENT),
		role: 'admin',
	}
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
		getPullRequest: [] as GitHubApiError[],
		getIssueComment: [] as GitHubApiError[],
		getCollaboratorRole: [] as GitHubApiError[],
	}
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
				return command.pullRequest
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
				return command.role
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
	return {
		api,
		threads,
		comments,
		writes,
		failures,
		threadReads,
		threadSnapshots,
		commentReads,
		commentSnapshots,
		reads,
		command,
	}
}
