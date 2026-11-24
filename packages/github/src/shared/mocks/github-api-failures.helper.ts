import type {
	ReviewThread,
	ThreadComment,
} from '../../platform/github-api.schema'
import type { GitHubApiError } from '../../platform/github.errors'

/** The failures each fake GitHub operation takes in turn, one queue per operation. */
export function toApiFailures() {
	return {
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
		unresolve: [] as (GitHubApiError | undefined)[],
		/** `undefined` lets that call succeed, so a later one can fail. */
		listThreads: [] as (GitHubApiError | undefined)[],
		listComments: [] as GitHubApiError[],
		/** `undefined` lets that call succeed, so a later one can fail. */
		getPullRequest: [] as (GitHubApiError | undefined)[],
		getIssueComment: [] as GitHubApiError[],
		getCollaboratorRole: [] as GitHubApiError[],
		/** `undefined` lets that call succeed, so a later one can fail. */
		listThreadComments: [] as (GitHubApiError | undefined)[],
		label: [] as GitHubApiError[],
		unlabel: [] as GitHubApiError[],
		editReply: [] as GitHubApiError[],
	}
}

/** The fake GitHub's thread state a comment edit changes. */
export interface ThreadState {
	readonly threads: ReviewThread[]
	readonly threadComments: Map<string, ThreadComment[]>
}

/** Replaces the body of the thread comment `id` wherever the fake keeps it. */
export function editThreadComment(
	state: ThreadState,
	id: number,
	body: string
): void {
	const edit = (comment: ThreadComment) =>
		comment.databaseId === id ? { ...comment, body } : comment
	for (const [index, thread] of state.threads.entries())
		state.threads[index] = {
			...thread,
			comments: { ...thread.comments, nodes: thread.comments.nodes.map(edit) },
			...(thread.latest
				? { latest: { nodes: thread.latest.nodes.map(edit) } }
				: {}),
		}
	for (const [threadId, comments] of state.threadComments)
		state.threadComments.set(threadId, comments.map(edit))
}
