import { Context, Effect, Layer, Result } from 'effect'
import { isDeclined, isTransient } from '../../../platform/github-api.helper'
import { GitHubApiService } from '../../../platform/github-api.service'
import { GitHubConfig } from '../../../platform/github.config'
import type { GitHubApiError } from '../../../platform/github.errors'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import type { SummaryMarker } from '../domain/publish-marker.schema'
import type {
	RenderedSummary,
	SummaryCleanup,
	SummaryComment,
} from '../domain/publish.types'
import {
	getDuplicateSummaries,
	getListedWaiting,
	getOwnSummary,
	getStaleSummaries,
	getSummary,
	toSummaryCleanup,
	toSummaryComments,
} from '../domain/summary-comment.helper'
import {
	toOfflineSummary,
	toReservedSummary,
} from '../presentation/summary-status.formatter'
import { toBlobLinks } from '../presentation/thread-comment.formatter'
import type { PublishTarget, StatusInput } from './publish.service.types'

const NOT_FOUND_STATUS = 404

/**
 * What a write left: the summary written, what became of other summaries, and whether the
 * summary kept is a comment this write created.
 */
export interface WrittenSummary extends RenderedSummary {
	readonly cleanup: SummaryCleanup
	readonly created: boolean
}

/** A manual run to count before the endpoint is used. */
export interface ManualRunInput extends PublishTarget {
	/** `commands.max_runs` at the reviewed base. */
	readonly maxRuns: number
	/** The handle commands mention; a summary the reservation creates names it in a code span. */
	readonly handle: string
}

/** Builds the summary over the one read just before the write; `undefined` when there is none. */
export type SummaryRender = (
	current: SummaryComment | undefined
) => RenderedSummary

/**
 * The summary written, the comments as read after the write, which the cleanup works from, and
 * whether the summary kept is this run's new comment.
 */
interface CreatedSummary {
	readonly rendered: RenderedSummary
	readonly summaries: readonly SummaryComment[]
	readonly created: boolean
}

/**
 * What a create left: the summaries read after it, this run's comment when it is among them, and
 * the create's error when it got no answer. With an error, `own` is only a comment with this run's
 * body, which another writer may have posted too.
 */
interface CreateAttempt {
	readonly summaries: readonly SummaryComment[]
	readonly own: number | undefined
	readonly failure: GitHubApiError | undefined
}

/** Leaves a comment visible on a failure that may not have been applied, retried on the next write. */
const keepOnFailure = Effect.orElseSucceed((): SummaryCleanup => 'kept')

/** True when GitHub answered that the comment does not exist. */
function isNotFound(error: GitHubApiError): boolean {
	return error.status === NOT_FOUND_STATUS
}

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
		 * current identity's summary, and another identity's summary moved to the current identity
		 * with the marker set to unfinished. `true` when the write created the summary it kept.
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
		/** The threads the summaries list as waiting for the owner, hidden summaries included (`getListedWaiting`). */
		readonly readWaiting: (
			pullNumber: number
		) => Effect.Effect<readonly string[], GitHubApiError, OwnedIdentities>
		/** Counts a manual run in the summary before it starts; `false` at the cap, with nothing written. */
		readonly reserveManualRun: (
			input: ManualRunInput
		) => Effect.Effect<boolean, GitHubApiError, OwnedIdentities>
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

		const readWaiting = Effect.fn('SummaryCommentService.readWaiting')(
			function* (pullNumber: number) {
				const { identities } = yield* OwnedIdentities
				return getListedWaiting(yield* api.listComments(pullNumber), identities)
			}
		)

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

		/** Deletes a comment; one GitHub no longer has counts as deleted. */
		const remove = Effect.fn('SummaryCommentService.remove')(function* (
			id: number
		) {
			return yield* api
				.deleteIssueComment(id)
				.pipe(Effect.catchIf(isNotFound, () => Effect.void))
		})

		/**
		 * After a create: the current identity's oldest summary is the one kept. When it is not this
		 * run's comment, it is edited over its own marker, and the cleanup deletes this run's. When
		 * that edit fails, the write fails; this run's comment is deleted first only when the create
		 * answered with its id, since a body match may be another writer's comment. A create with no
		 * answer and no summary found fails with its error.
		 */
		const settle = Effect.fn('SummaryCommentService.settle')(function* (
			render: SummaryRender,
			rendered: RenderedSummary,
			attempt: CreateAttempt
		) {
			const { summaries, own, failure } = attempt
			const oldest = getOwnSummary(summaries)
			if (!oldest && failure) return yield* failure
			if (!oldest || oldest.id === own)
				return { rendered, summaries, created: true } satisfies CreatedSummary
			const updated = yield* Effect.result(update(oldest, render))
			if (Result.isSuccess(updated))
				return {
					rendered: updated.success,
					summaries,
					created: false,
				} satisfies CreatedSummary
			if (own !== undefined && !failure) yield* Effect.ignore(remove(own))
			return yield* updated.failure
		})

		/**
		 * Creates the summary, then reads again and settles on the identity's oldest. A create with
		 * no answer or a 5xx is checked by that read: the newest summary of the current identity that
		 * was not in `before` and has this run's body is taken as this run's own create. When the read
		 * after a create fails, the write fails without creating again, since it cannot tell whether
		 * another writer created one meanwhile. `gone` is a summary GitHub just answered 404 for,
		 * never picked again.
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
				if (!isTransient(created.failure)) return yield* created.failure
				const summaries = yield* listLive
				const known = new Set(before.map(summary => summary.id))
				const own = summaries.findLast(
					summary =>
						summary.mine &&
						!known.has(summary.id) &&
						summary.body === rendered.body
				)
				return yield* settle(render, rendered, {
					summaries,
					own: own?.id,
					failure: created.failure,
				})
			}
			return yield* settle(render, rendered, {
				summaries: yield* listLive,
				own: created.success,
				failure: undefined,
			})
		})

		/**
		 * Hides each summary of another identity, deleting it only when GitHub refuses to hide it;
		 * deletes the current identity's duplicates after its oldest. Anything left visible that
		 * should not be reports `kept`, and the next write tries again.
		 */
		const cleanUp = Effect.fn('SummaryCommentService.cleanUp')(function* (
			summaries: readonly SummaryComment[]
		) {
			const stale = yield* Effect.forEach(
				getStaleSummaries(summaries),
				summary =>
					api.minimizeComment(summary.nodeId).pipe(
						Effect.as<SummaryCleanup>('minimized'),
						Effect.catchIf(isDeclined, () =>
							remove(summary.id).pipe(
								Effect.as<SummaryCleanup>('deleted'),
								keepOnFailure
							)
						),
						keepOnFailure
					),
				{ concurrency: 1 }
			)
			const duplicates = yield* Effect.forEach(
				getDuplicateSummaries(summaries),
				summary =>
					remove(summary.id).pipe(
						Effect.as<SummaryCleanup>('none'),
						keepOnFailure
					),
				{ concurrency: 1 }
			)
			return toSummaryCleanup([...stale, ...duplicates])
		})

		/**
		 * Writes over summaries just read, so `render` builds on what another run wrote meanwhile.
		 * Edits the current identity's summary, or creates one when there is none or it was deleted,
		 * then cleans up.
		 */
		const writeOver = Effect.fn('SummaryCommentService.writeOver')(function* (
			pullNumber: number,
			render: SummaryRender,
			summaries: readonly SummaryComment[]
		) {
			const current = getSummary(summaries)
			const rendered = render(current)
			const gone = current?.mine ? current.id : undefined
			if (current?.mine) {
				const updated = yield* api
					.updateIssueComment(current.id, rendered.body)
					.pipe(
						Effect.as(true),
						Effect.catchIf(isNotFound, () => Effect.succeed(false))
					)
				if (updated)
					return {
						...rendered,
						cleanup: yield* cleanUp(summaries),
						created: false,
					} satisfies WrittenSummary
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
				created: created.created,
			} satisfies WrittenSummary
		})

		const write = Effect.fn('SummaryCommentService.write')(function* (
			pullNumber: number,
			render: SummaryRender
		) {
			return yield* writeOver(pullNumber, render, yield* list(pullNumber))
		})

		/**
		 * The offline path, a write like any other: the current identity's summary keeps its text with
		 * the marker set to unfinished; another identity's summary moves to the current identity the
		 * same way, so the unfinished run is on record; with none, a status summary is created.
		 */
		const publishStatus = Effect.fn('SummaryCommentService.publishStatus')(
			function* (input: StatusInput) {
				const links = toBlobLinks(config, input)
				const written = yield* write(input.pullNumber, current =>
					toOfflineSummary(current, input.status, links)
				)
				return written.created
			}
		)

		const readPrior = Effect.fn('SummaryCommentService.readPrior')(function* (
			pullNumber: number
		) {
			return (yield* read(pullNumber))?.marker
		})

		/**
		 * Counts a manual run in the marker of the summary a run builds on, before the endpoint is
		 * used, so a run that fails later still counts. A write like any other: the current
		 * identity's summary keeps its text, another identity's moves to the current identity, and
		 * with none a status summary is created. `false` at `maxRuns`, with nothing written.
		 */
		const reserveManualRun = Effect.fn(
			'SummaryCommentService.reserveManualRun'
		)(function* (input: ManualRunInput) {
			const summaries = yield* list(input.pullNumber)
			const used = getSummary(summaries)?.marker.manualRuns ?? 0
			if (used >= input.maxRuns) return false
			const links = toBlobLinks(config, input)
			yield* writeOver(
				input.pullNumber,
				current => toReservedSummary(current, input.handle, links),
				summaries
			)
			return true
		})

		return {
			read,
			write,
			publishStatus,
			readPrior,
			readWaiting,
			reserveManualRun,
		}
	})
)
