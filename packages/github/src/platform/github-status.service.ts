import { Context, Effect, Layer, Schema } from 'effect'
import { HttpClientRequest } from 'effect/http'
import { isOwnedCreator } from './bot-identity.helper'
import { MAX_PAGES, PAGE_SIZE } from './github-api.constants'
import { read } from './github-api.helper'
import {
	type CommitStatus,
	commitStatusSchema,
	createdSchema,
	type OpenPullRequest,
	openPullRequestSchema,
} from './github-api.schema'
import { makeGitHubHttp } from './github-http.client'
import { GitHubApiError } from './github.errors'
import { OwnedIdentities } from './owned-identities.context'

export const STATUS_CONTEXT = 'MNG Review'
export const COMMIT_STATES = ['success', 'failure', 'error', 'pending'] as const
export type CommitState = (typeof COMMIT_STATES)[number]
export const CHECK_CONCLUSIONS = ['success', 'neutral'] as const
export type CheckConclusion = (typeof CHECK_CONCLUSIONS)[number]

/** A finished check run on a commit. */
export interface CheckRunInput {
	readonly headSha: string
	readonly name: string
	readonly conclusion: CheckConclusion
	readonly title: string
	readonly summary: string
}

/** The `MNG Review` status to set on a commit. */
export interface CommitStatusInput {
	readonly sha: string
	readonly state: CommitState
	readonly description: string
}

/** How the open list ends past `MAX_PAGES` pages. */
export interface OpenPullsOptions {
	/** Fail rather than stop there, for a caller that must not act on a cut list. */
	readonly complete?: boolean
}

/** Check runs and the `MNG Review` commit status, and the reads the status sweep needs. */
export class GitHubStatusService extends Context.Service<
	GitHubStatusService,
	{
		readonly createCheckRun: (
			input: CheckRunInput
		) => Effect.Effect<void, GitHubApiError>
		readonly setStatus: (
			input: CommitStatusInput
		) => Effect.Effect<void, GitHubApiError>
		/** The newest `MNG Review` status an owned bot identity set on the commit, if any. */
		readonly getStatus: (
			sha: string
		) => Effect.Effect<
			CommitStatus | undefined,
			GitHubApiError,
			OwnedIdentities
		>
		/**
		 * Every open pull request, page by page. Past `MAX_PAGES` full pages the list stops there,
		 * or with `complete` fails.
		 */
		readonly listOpenPullRequests: (
			options?: OpenPullsOptions
		) => Effect.Effect<readonly OpenPullRequest[], GitHubApiError>
	}
>()('mng-review/GitHubStatusService') {}

/** GitHub's limit on a status description. */
const MAX_DESCRIPTION_CHARS = 140

export const GitHubStatusServiceLive = Layer.effect(
	GitHubStatusService,
	Effect.gen(function* () {
		const { repo, sendJson } = yield* makeGitHubHttp

		const createCheckRun = Effect.fn('GitHubStatusService.createCheckRun')(
			function* (input: CheckRunInput) {
				yield* sendJson(
					'createCheckRun',
					HttpClientRequest.post(`${repo}/check-runs`).pipe(
						HttpClientRequest.bodyJsonUnsafe({
							name: input.name,
							head_sha: input.headSha,
							status: 'completed',
							conclusion: input.conclusion,
							output: { title: input.title, summary: input.summary },
						})
					),
					createdSchema
				)
			}
		)

		const setStatus = Effect.fn('GitHubStatusService.setStatus')(function* (
			input: CommitStatusInput
		) {
			yield* sendJson(
				'setStatus',
				HttpClientRequest.post(`${repo}/statuses/${input.sha}`).pipe(
					HttpClientRequest.bodyJsonUnsafe({
						state: input.state,
						context: STATUS_CONTEXT,
						description: input.description.slice(0, MAX_DESCRIPTION_CHARS),
					})
				),
				createdSchema
			)
		})

		const getStatus = Effect.fn('GitHubStatusService.getStatus')(function* (
			sha: string
		) {
			const { identities } = yield* OwnedIdentities
			const statuses = yield* read(
				sendJson(
					'getStatus',
					HttpClientRequest.get(`${repo}/commits/${sha}/statuses`).pipe(
						HttpClientRequest.setUrlParams({ per_page: String(PAGE_SIZE) })
					),
					Schema.Array(commitStatusSchema)
				)
			)
			return statuses.find(
				status =>
					status.context === STATUS_CONTEXT &&
					isOwnedCreator(status.creator, identities)
			)
		})

		/** One page of open pull requests and the pages after it, up to `MAX_PAGES`. */
		const pullsPage = (
			page: number,
			complete: boolean
		): Effect.Effect<readonly OpenPullRequest[], GitHubApiError> =>
			read(
				sendJson(
					'listOpenPullRequests',
					HttpClientRequest.get(`${repo}/pulls`).pipe(
						HttpClientRequest.setUrlParams({
							state: 'open',
							per_page: String(PAGE_SIZE),
							page: String(page),
						})
					),
					Schema.Array(openPullRequestSchema)
				)
			).pipe(
				Effect.flatMap(pulls => {
					if (pulls.length < PAGE_SIZE) return Effect.succeed(pulls)
					if (page < MAX_PAGES)
						return pullsPage(page + 1, complete).pipe(
							Effect.map(rest => [...pulls, ...rest])
						)
					if (!complete) return Effect.succeed(pulls)
					return Effect.fail(
						new GitHubApiError({
							operation: 'listOpenPullRequests',
							reason: `more than ${MAX_PAGES * PAGE_SIZE} entries`,
						})
					)
				})
			)

		const listOpenPullRequests = Effect.fn(
			'GitHubStatusService.listOpenPullRequests'
		)(function* (options?: OpenPullsOptions) {
			return yield* pullsPage(1, options?.complete === true)
		})

		return { createCheckRun, setStatus, getStatus, listOpenPullRequests }
	})
)
