import { RISK_STATUS_CONTEXT, type RiskStatusState } from '@mng-review/domain'
import { Context, Effect, Layer, Predicate, Schema } from 'effect'
import { HttpClientRequest } from 'effect/http'
import { MAX_PAGES, PAGE_SIZE } from './github-api.constants'
import { collect, read } from './github-api.helper'
import { createdSchema } from './github-api.schema'
import { makeGitHubHttp } from './github-http.client'
import {
	type CommentEdits,
	commentEditsAnswerSchema,
	type RiskCommitStatus,
	riskCommitStatusSchema,
	runCreatedSchema,
	type TimelineItem,
	timelineAnswerSchema,
} from './github-risk.schema'
import { GitHubApiError } from './github.errors'

/** The `MNG Review risk` status to write on a commit; the description is the one form. */
export interface RiskStatusInput {
	readonly sha: string
	readonly state: RiskStatusState
	readonly description: string
}

/**
 * The pull request's commits, both sides of every force push, its label events and its
 * conversation comments, in the order they happened.
 */
export const TIMELINE_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(first: ${PAGE_SIZE}, after: $cursor, itemTypes: [PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT, LABELED_EVENT, UNLABELED_EVENT, ISSUE_COMMENT]) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on PullRequestCommit { commit { oid } }
          ... on HeadRefForcePushedEvent { beforeCommit { oid } afterCommit { oid } }
          ... on LabeledEvent { actor { __typename login } label { name } }
          ... on UnlabeledEvent { actor { __typename login } label { name } }
          ... on IssueComment { databaseId }
        }
      }
    }
  }
}`

/** Pages of a comment's edit history the read takes; a longer history fails the read. */
export const COMMENT_EDIT_PAGES = 5

/**
 * One page of a conversation comment's body, how many edits GitHub counts for it, and each edit on
 * the page: its id, who made it, when, and the whole text it left (`diff`). GitHub lists the
 * created version as the oldest entry once the comment is edited, an app's own edits show with the
 * app as `Bot`, and it keeps only the newest 100 edits, so readers match edits by id.
 */
export const COMMENT_EDITS_QUERY = `query($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on IssueComment {
      body
      userContentEdits(first: ${PAGE_SIZE}, after: $cursor) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { id editedAt editor { __typename login } diff }
      }
    }
  }
}`

/**
 * The risk rating's own reads and its one write: every status of a commit, the timeline, the
 * status.
 */
export class GitHubRiskService extends Context.Service<
	GitHubRiskService,
	{
		/** Every status of the commit, every page, newest first; more than `MAX_PAGES` pages fails. */
		readonly listStatuses: (
			sha: string
		) => Effect.Effect<readonly RiskCommitStatus[], GitHubApiError>
		/** Writes `MNG Review risk`; a description over GitHub's 140 characters is refused, never cut. */
		readonly createStatus: (
			input: RiskStatusInput
		) => Effect.Effect<void, GitHubApiError>
		/**
		 * Every page of the pull request's timeline items the rating reads. An item GitHub lists as a
		 * null node fails the read, since it may be a head that holds the only High.
		 */
		readonly listTimeline: (
			pullNumber: number
		) => Effect.Effect<readonly TimelineItem[], GitHubApiError>
		/**
		 * The comment's body and its whole edit history by its node id, every page. A missing comment
		 * or page, a count that changes between pages, or more than `COMMENT_EDIT_PAGES` pages fails.
		 */
		readonly readCommentEdits: (
			nodeId: string
		) => Effect.Effect<CommentEdits, GitHubApiError>
		/** When the workflow run was created, as GitHub gives it. */
		readonly getRunCreated: (
			runId: number
		) => Effect.Effect<string, GitHubApiError>
	}
>()('mng-review/GitHubRiskService') {}

/** A failed edit history read. */
function editsFailure(reason: string) {
	return Effect.fail(
		new GitHubApiError({ operation: 'readCommentEdits', reason })
	)
}

/** GitHub's limit on a status description. */
const MAX_DESCRIPTION_CHARS = 140

export const GitHubRiskServiceLive = Layer.effect(
	GitHubRiskService,
	Effect.gen(function* () {
		const { config, repo, sendJson, query } = yield* makeGitHubHttp

		/** One page of statuses and the pages after it; a page past `MAX_PAGES` fails the read. */
		const statusPage = (
			sha: string,
			page: number
		): Effect.Effect<readonly RiskCommitStatus[], GitHubApiError> =>
			read(
				sendJson(
					'listStatuses',
					HttpClientRequest.get(`${repo}/commits/${sha}/statuses`).pipe(
						HttpClientRequest.setUrlParams({
							per_page: String(PAGE_SIZE),
							page: String(page),
						})
					),
					Schema.Array(riskCommitStatusSchema)
				)
			).pipe(
				Effect.flatMap(statuses => {
					if (statuses.length < PAGE_SIZE) return Effect.succeed(statuses)
					if (page >= MAX_PAGES)
						return Effect.fail(
							new GitHubApiError({
								operation: 'listStatuses',
								reason: `more than ${MAX_PAGES * PAGE_SIZE} statuses`,
							})
						)
					return statusPage(sha, page + 1).pipe(
						Effect.map(rest => [...statuses, ...rest])
					)
				})
			)

		const listStatuses = Effect.fn('GitHubRiskService.listStatuses')(function* (
			sha: string
		) {
			return yield* statusPage(sha, 1)
		})

		const createStatus = Effect.fn('GitHubRiskService.createStatus')(function* (
			input: RiskStatusInput
		) {
			if (input.description.length > MAX_DESCRIPTION_CHARS)
				return yield* new GitHubApiError({
					operation: 'createStatus',
					reason: 'the description is longer than GitHub allows',
				})
			return yield* sendJson(
				'createStatus',
				HttpClientRequest.post(`${repo}/statuses/${input.sha}`).pipe(
					HttpClientRequest.bodyJsonUnsafe({
						state: input.state,
						context: RISK_STATUS_CONTEXT,
						description: input.description,
					})
				),
				createdSchema
			).pipe(Effect.asVoid)
		})

		const getRunCreated = Effect.fn('GitHubRiskService.getRunCreated')(
			function* (runId: number) {
				const run = yield* read(
					sendJson(
						'getRunCreated',
						HttpClientRequest.get(`${repo}/actions/runs/${runId}`),
						runCreatedSchema
					)
				)
				return run.created_at
			}
		)

		const listTimeline = Effect.fn('GitHubRiskService.listTimeline')(function* (
			pullNumber: number
		) {
			return yield* collect(
				'listTimeline',
				cursor =>
					query(
						'listTimeline',
						TIMELINE_QUERY,
						{
							owner: config.owner,
							name: config.name,
							number: pullNumber,
							cursor,
						},
						timelineAnswerSchema
					).pipe(
						Effect.flatMap(answer => {
							const items = answer.data?.repository?.pullRequest?.timelineItems
							if (!items?.nodes.some(Predicate.isNull))
								return Effect.succeed(items)
							return Effect.fail(
								new GitHubApiError({
									operation: 'listTimeline',
									reason: 'GitHub listed a timeline item as a null node',
								})
							)
						})
					),
				null,
				0
			)
		})

		/** One page of a comment's edit history and the pages after it, read with the page's cursor. */
		const editsPage = (
			nodeId: string,
			cursor: string | null,
			page: number
		): Effect.Effect<CommentEdits, GitHubApiError> =>
			query(
				'readCommentEdits',
				COMMENT_EDITS_QUERY,
				{ id: nodeId, cursor },
				commentEditsAnswerSchema
			).pipe(
				Effect.flatMap(answer => {
					const comment = answer.data?.node
					const edits = comment?.userContentEdits
					if (!(comment && edits))
						return editsFailure('the comment or its edit history did not read')
					const pageRead = {
						body: comment.body,
						total: edits.totalCount,
						edits: edits.nodes,
					} satisfies CommentEdits
					const { hasNextPage, endCursor } = edits.pageInfo
					if (!hasNextPage) return Effect.succeed(pageRead)
					if (!endCursor) return editsFailure('more edits without a cursor')
					if (page >= COMMENT_EDIT_PAGES)
						return editsFailure(
							`more than ${COMMENT_EDIT_PAGES} pages of edits`
						)
					return editsPage(nodeId, endCursor, page + 1).pipe(
						Effect.flatMap(rest =>
							rest.total === pageRead.total
								? Effect.succeed({
										...pageRead,
										edits: [...pageRead.edits, ...rest.edits],
									})
								: editsFailure('the edit count changed between pages')
						)
					)
				})
			)

		const readCommentEdits = Effect.fn('GitHubRiskService.readCommentEdits')(
			function* (nodeId: string) {
				return yield* editsPage(nodeId, null, 1)
			}
		)

		return {
			listStatuses,
			createStatus,
			listTimeline,
			readCommentEdits,
			getRunCreated,
		}
	})
)
