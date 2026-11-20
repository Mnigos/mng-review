import { Context, Effect, Layer, Result } from 'effect'
import { SERVER_ERROR_STATUS } from '../../../platform/github-api.constants'
import { GitHubApiService } from '../../../platform/github-api.service'
import { GitHubConfig } from '../../../platform/github.config'
import type { GitHubApiError } from '../../../platform/github.errors'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import type { SummaryMarker } from '../domain/publish-marker.schema'
import { MARKER_VERSION } from '../domain/publish.constants'
import type { SummaryCleanup, SummaryComment } from '../domain/publish.types'
import {
	getOwnSummary,
	getStaleSummaries,
	getSummary,
	toSummaryCleanup,
	toSummaryComments,
} from '../domain/summary-comment.helper'
import {
	formatStatusComment,
	toUnfinishedSummary,
} from '../presentation/summary-comment.formatter'
import { toBlobLinks } from '../presentation/thread-comment.formatter'
import type { StatusInput } from './publish.service.types'

const NOT_FOUND_STATUS = 404

/** A summary built from the summary read just before it is written: its text and marker. */
export interface RenderedSummary {
	readonly body: string
	readonly marker: SummaryMarker
}

/** What a write left: the summary written and what became of other identities' summaries. */
export interface WrittenSummary extends RenderedSummary {
	readonly cleanup: SummaryCleanup
}

/** Builds the summary over the one read just before the write; `undefined` when there is none. */
export type SummaryRender = (
	current: SummaryComment | undefined
) => RenderedSummary

/** The summary written and the comments as read after the write, which the cleanup works from. */
interface CreatedSummary {
	readonly rendered: RenderedSummary
	readonly summaries: readonly SummaryComment[]
}

/** True when a create may have been stored although GitHub did not say so. */
function isUnanswered(error: GitHubApiError): boolean {
	return error.status === undefined || error.status >= SERVER_ERROR_STATUS
}

/**
 * The bot's sticky summary comment across identities. The current identity's oldest summary is
 * edited in place; without one, the oldest summary of another owned identity is the prior state,
 * a new summary is created over its marker, and the old one is hidden, or deleted when hiding is
 * refused. The bot never edits a comment another identity wrote.
 */
export class SummaryCommentService extends Context.Service<
	SummaryCommentService,
	{
		readonly read: (
			pullNumber: number
		) => Effect.Effect<
			SummaryComment | undefined,
			GitHubApiError,
			OwnedIdentities
		>
		readonly write: (
			pullNumber: number,
			render: SummaryRender
		) => Effect.Effect<WrittenSummary, GitHubApiError, OwnedIdentities>
		/**
		 * The offline path: a status summary when there is none, the marker set to unfinished on the
		 * current identity's summary, and nothing at all when only another identity's exists. `false`
		 * when no summary was created.
		 */
		readonly publishStatus: (
			input: StatusInput
		) => Effect.Effect<boolean, GitHubApiError, OwnedIdentities>
		/** The marker of the summary a run builds on: run count and last finished head. */
		readonly readPrior: (
			pullNumber: number
		) => Effect.Effect<
			SummaryMarker | undefined,
			GitHubApiError,
			OwnedIdentities
		>
	}
>()('mng-review/SummaryCommentService') {}

export const SummaryCommentServiceLive = Layer.effect(
	SummaryCommentService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService
		const config = yield* GitHubConfig

		const list = Effect.fn('SummaryCommentService.list')(function* (
			pullNumber: number
		) {
			const { current, identities } = yield* OwnedIdentities
			return toSummaryComments(
				yield* api.listComments(pullNumber),
				identities,
				current
			)
		})

		const read = Effect.fn('SummaryCommentService.read')(function* (
			pullNumber: number
		) {
			return getSummary(yield* list(pullNumber))
		})

		/** Edits the current identity's summary with `render` over its own marker. */
		const update = Effect.fn('SummaryCommentService.update')(function* (
			summary: SummaryComment,
			render: SummaryRender
		) {
			const rendered = render(summary)
			yield* api.updateIssueComment(summary.id, rendered.body)
			return rendered
		})

		/**
		 * Creates the summary, then reads again. Another run's older summary of the same identity
		 * wins: it is edited over its own marker and this run's comment is deleted. A create with no
		 * answer or a 5xx is checked by that read before anything else; with no summary found, the
		 * create's error stands. `gone` is a summary GitHub just answered 404 for, never picked again.
		 */
		const create = Effect.fn('SummaryCommentService.create')(function* (
			pullNumber: number,
			render: SummaryRender,
			rendered: RenderedSummary,
			before: readonly SummaryComment[],
			gone: number | undefined
		) {
			const listLive = list(pullNumber).pipe(
				Effect.map(summaries =>
					summaries.filter(summary => summary.id !== gone)
				)
			)
			const created = yield* Effect.result(
				api.createIssueComment(pullNumber, rendered.body)
			)
			if (Result.isFailure(created)) {
				if (!isUnanswered(created.failure)) return yield* created.failure
				const summaries = yield* listLive
				const stored = getOwnSummary(summaries)
				if (!stored) return yield* created.failure
				return {
					rendered: yield* update(stored, render),
					summaries,
				} satisfies CreatedSummary
			}
			const after = yield* Effect.result(listLive)
			if (Result.isFailure(after))
				return { rendered, summaries: before } satisfies CreatedSummary
			const summaries = after.success
			const oldest = getOwnSummary(summaries)
			if (!oldest || oldest.id === created.success)
				return { rendered, summaries } satisfies CreatedSummary
			const kept = yield* Effect.result(update(oldest, render))
			if (Result.isFailure(kept))
				return { rendered, summaries } satisfies CreatedSummary
			yield* api.deleteIssueComment(created.success).pipe(Effect.ignore)
			return { rendered: kept.success, summaries } satisfies CreatedSummary
		})

		/** Hides each summary of another identity, deletes it when hiding is refused, else keeps it. */
		const cleanUp = Effect.fn('SummaryCommentService.cleanUp')(function* (
			summaries: readonly SummaryComment[]
		) {
			const outcomes = yield* Effect.forEach(
				getStaleSummaries(summaries),
				summary =>
					api.minimizeComment(summary.nodeId).pipe(
						Effect.as<SummaryCleanup>('minimized'),
						Effect.catch(() =>
							api.deleteIssueComment(summary.id).pipe(
								Effect.as<SummaryCleanup>('deleted'),
								Effect.orElseSucceed((): SummaryCleanup => 'kept')
							)
						)
					),
				{ concurrency: 1 }
			)
			return toSummaryCleanup(outcomes)
		})

		/**
		 * Reads the summaries just before writing, so `render` builds on what another run wrote
		 * meanwhile. Edits the current identity's summary, or creates one when there is none or it
		 * was deleted, then hides the summaries of other identities.
		 */
		const write = Effect.fn('SummaryCommentService.write')(function* (
			pullNumber: number,
			render: SummaryRender
		) {
			const summaries = yield* list(pullNumber)
			const current = getSummary(summaries)
			const rendered = render(current)
			const gone = current?.mine ? current.id : undefined
			if (current?.mine) {
				const updated = yield* api
					.updateIssueComment(current.id, rendered.body)
					.pipe(
						Effect.as(true),
						Effect.catchIf(
							error => error.status === NOT_FOUND_STATUS,
							() => Effect.succeed(false)
						)
					)
				if (updated) return { ...rendered, cleanup: yield* cleanUp(summaries) }
			}
			const created = yield* create(
				pullNumber,
				render,
				rendered,
				summaries.filter(summary => summary.id !== gone),
				gone
			)
			return {
				...created.rendered,
				cleanup: yield* cleanUp(created.summaries),
			} satisfies WrittenSummary
		})

		const publishStatus = Effect.fn('SummaryCommentService.publishStatus')(
			function* (input: StatusInput) {
				const summary = yield* read(input.pullNumber)
				if (summary?.mine)
					yield* api.updateIssueComment(
						summary.id,
						toUnfinishedSummary(summary.body, summary.marker)
					)
				if (summary) return false
				yield* api.createIssueComment(
					input.pullNumber,
					formatStatusComment(
						input.status,
						{ v: MARKER_VERSION, runs: 0, finished: false },
						toBlobLinks(config, input)
					)
				)
				return true
			}
		)

		const readPrior = Effect.fn('SummaryCommentService.readPrior')(function* (
			pullNumber: number
		) {
			return (yield* read(pullNumber))?.marker
		})

		return { read, write, publishStatus, readPrior }
	})
)
