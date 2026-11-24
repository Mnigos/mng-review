import { RISK_STATUS_CONTEXT, type RiskStatusState } from '@mng-review/domain'
import { Context, Effect, Layer, Schema } from 'effect'
import { HttpClientRequest } from 'effect/http'
import { MAX_PAGES, PAGE_SIZE } from './github-api.constants'
import { collect, pages, read } from './github-api.helper'
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
	type WorkflowJob,
	type WorkflowRun,
	workflowJobsPageSchema,
	workflowRunsPageSchema,
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
          ... on PullRequestCommit { commit { oid committedDate } }
          ... on HeadRefForcePushedEvent { createdAt beforeCommit { oid } afterCommit { oid } }
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

/** A `workflow_dispatch` of a workflow on a ref, with its inputs. */
export interface DispatchInput {
	/** The workflow file name, such as `review.yml`. */
	readonly workflow: string
	readonly ref: string
	readonly inputs: Readonly<Record<string, string>>
}

/**
 * The runs list filter: one workflow's runs or every workflow's, one status per call, the event
 * that started them, their branch, and a lower bound on their creation time.
 */
export interface RunsQuery {
	/** The workflow file name, such as `review.yml`; without it, the runs of every workflow. */
	readonly workflow?: string
	readonly status?: string
	readonly event?: string
	readonly branch?: string
	/** Only runs created at or after this time; paging stops at the first older run. */
	readonly since?: string
}

/** The risk rating's GitHub reads and writes: statuses, timeline, edits, runs and dispatches. */
export class GitHubRiskService extends Context.Service<
	GitHubRiskService,
	{
		/** Every status of the commit, every page, newest first; more than `MAX_PAGES` pages fails. */
		readonly listStatuses: (
			sha: string
		) => Effect.Effect<readonly RiskCommitStatus[], GitHubApiError>
		/**
		 * Writes `MNG Review risk`; a description over GitHub's 140 characters is refused, never cut.
		 */
		readonly createStatus: (
			input: RiskStatusInput
		) => Effect.Effect<void, GitHubApiError>
		/**
		 * Every page of the pull request's timeline items the rating reads. An item GitHub lists as a
		 * null node fails the read (`collect`), since it may be a head that holds the only High.
		 */
		readonly listTimeline: (
			pullNumber: number
		) => Effect.Effect<readonly TimelineItem[], GitHubApiError>
		/**
		 * The comment's body and its whole edit history by its node id, every page, with an edit
		 * GitHub lists as a null node kept as `null`. A missing comment or page, a count that changes
		 * between pages, or more than `COMMENT_EDIT_PAGES` pages fails.
		 */
		readonly readCommentEdits: (
			nodeId: string
		) => Effect.Effect<CommentEdits, GitHubApiError>
		/** When the workflow run was created, as GitHub gives it. */
		readonly getRunCreated: (
			runId: number
		) => Effect.Effect<string, GitHubApiError>
		/**
		 * Every page of the workflow runs the query names, newest first, down to its lower bound. More
		 * than `MAX_PAGES` pages, or fewer runs than GitHub's `total_count` (a filtered search ends at
		 * 1,000), fails the read, so a caller holds rather than act on a partial list.
		 */
		readonly listRuns: (
			query: RunsQuery
		) => Effect.Effect<readonly WorkflowRun[], GitHubApiError>
		/** Every job of one run, with its name and conclusion. */
		readonly listRunJobs: (
			runId: number
		) => Effect.Effect<readonly WorkflowJob[], GitHubApiError>
		/** Starts a workflow on a ref; GitHub answers no body and no run id. */
		readonly dispatch: (
			input: DispatchInput
		) => Effect.Effect<void, GitHubApiError>
	}
>()('mng-review/GitHubRiskService') {}

/** A failed edit history read. */
function editsFailure(reason: string) {
	return Effect.fail(
		new GitHubApiError({ operation: 'readCommentEdits', reason })
	)
}

/** True for a run created before the lower bound; the list is newest first. */
function isOlder(run: WorkflowRun, since: string | undefined): boolean {
	return since !== undefined && run.created_at < since
}

/** GitHub's limit on a status description. */
const MAX_DESCRIPTION_CHARS = 140

export const GitHubRiskServiceLive = Layer.effect(
	GitHubRiskService,
	Effect.gen(function* () {
		const { config, repo, sendJson, sendEmpty, query } = yield* makeGitHubHttp

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
						Effect.map(
							answer => answer.data?.repository?.pullRequest?.timelineItems
						)
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

		const listRuns = Effect.fn('GitHubRiskService.listRuns')(function* (
			runs: RunsQuery
		) {
			const path = runs.workflow
				? `${repo}/actions/workflows/${encodeURIComponent(runs.workflow)}/runs`
				: `${repo}/actions/runs`
			const listed = yield* pages(
				'listRuns',
				page =>
					sendJson(
						'listRuns',
						HttpClientRequest.get(path).pipe(
							HttpClientRequest.setUrlParams({
								...(runs.status ? { status: runs.status } : {}),
								...(runs.event ? { event: runs.event } : {}),
								...(runs.branch ? { branch: runs.branch } : {}),
								...(runs.since ? { created: `>=${runs.since}` } : {}),
								per_page: String(PAGE_SIZE),
								page: String(page),
							})
						),
						workflowRunsPageSchema
					).pipe(
						Effect.map(answer => ({
							entries: answer.workflow_runs,
							total: answer.total_count,
						}))
					),
				1,
				entries => entries.some(run => isOlder(run, runs.since))
			)
			return listed.filter(run => !isOlder(run, runs.since))
		})

		const listRunJobs = Effect.fn('GitHubRiskService.listRunJobs')(function* (
			runId: number
		) {
			return yield* pages(
				'listRunJobs',
				page =>
					sendJson(
						'listRunJobs',
						HttpClientRequest.get(`${repo}/actions/runs/${runId}/jobs`).pipe(
							HttpClientRequest.setUrlParams({
								per_page: String(PAGE_SIZE),
								page: String(page),
							})
						),
						workflowJobsPageSchema
					).pipe(Effect.map(answer => ({ entries: answer.jobs }))),
				1
			)
		})

		const dispatch = Effect.fn('GitHubRiskService.dispatch')(function* (
			input: DispatchInput
		) {
			return yield* sendEmpty(
				'dispatch',
				HttpClientRequest.post(
					`${repo}/actions/workflows/${encodeURIComponent(input.workflow)}/dispatches`
				).pipe(
					HttpClientRequest.bodyJsonUnsafe({
						ref: input.ref,
						inputs: input.inputs,
					})
				)
			)
		})

		return {
			listStatuses,
			createStatus,
			listTimeline,
			readCommentEdits,
			getRunCreated,
			listRuns,
			listRunJobs,
			dispatch,
		}
	})
)
