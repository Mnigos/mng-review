import {
	type AnswerEntry,
	type AnswerKind,
	isActedOnAuthor,
	PERSON_TYPE,
} from '@mng-review/domain'
import { Context, Effect, Layer, Predicate } from 'effect'
import { isNotFound } from '../../../platform/github-api.helper'
import type { PullRequestComment } from '../../../platform/github-api.schema'
import { GitHubApiService } from '../../../platform/github-api.service'
import { GitHubReviewService } from '../../../platform/github-review.service'
import { GitHubRiskService } from '../../../platform/github-risk.service'
import type { GitHubApiError } from '../../../platform/github.errors'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import { parseMentionCommand } from '../../command/domain/mention-command.parser'
import {
	parseAnswerMarker,
	parseSummaryMarker,
} from '../../publish/domain/publish-marker.parser'
import {
	type AnswerNeed,
	type CommentVersion,
	isAnswered,
	toAnswerEntry,
} from '../domain/answer.helper'
import { getCountedReviews } from '../domain/command-cap.helper'
import { toCommentVersion } from '../domain/reply-answer.helper'
import {
	getCommentsSinceHead,
	isAppAuthored,
} from '../domain/risk-history.helper'

/** A conversation comment that holds a command for the handle, with its author's standing. */
export interface ReadCommand extends CommentVersion {
	readonly agent?: string
	readonly actedOn: boolean
}

/** What every answer read gives: the commands for the handle and the app's trusted entries. */
export interface CommandRead {
	readonly commands: readonly ReadCommand[]
	readonly entries: readonly AnswerEntry[]
}

/** What an answer names: its run, its kind and, for `run <agent>`, the agent. */
export interface AnswerRequest {
	readonly pullNumber: number
	readonly run: number
	/** When the run started, as GitHub writes times: a command's version after it was not read. */
	readonly before: string
	readonly kind: Extract<AnswerKind, 'review' | 'run'>
	readonly agent?: string
}

/** The command the cap decides on, on the head it would rate. */
export interface CapRequest {
	readonly pullNumber: number
	readonly head: string
	readonly commentId: number
	readonly cap: number
}

/**
 * The commands on a pull request as the engine reads them (conversation comments only, the
 * `parseMentionCommand` grammar, the app's slug as the handle), whose authors the bot acts on, and
 * the entries of the current app's answers: answer and summary markers it wrote and no one else
 * edited. A previous identity's answers name nothing; its comments still count as the bot's. A
 * confirmed non-collaborator (a 404 on the role read) is not acted on; any other failed role read
 * fails the read, so the decide job fails rather than guess.
 */
export class AnswerReadService extends Context.Service<
	AnswerReadService,
	{
		readonly readCommands: (
			pullNumber: number
		) => Effect.Effect<CommandRead, GitHubApiError, OwnedIdentities>
		/**
		 * The entry an answer of `kind` carries: every command of that kind (and agent) from an
		 * acted-on author its read saw that no trusted answer names at its current version with a
		 * qualifying run (`isAnswered`). Its read is the run's, so a command created or edited at or
		 * after `before` is left for its own run, and so is one at or after the run's creation time,
		 * which the merge tool requires an answering run to follow: GitHub's times are whole seconds,
		 * so the same second never counts. A failed run read fails the call.
		 */
		readonly getCommandEntry: (
			request: AnswerRequest
		) => Effect.Effect<AnswerEntry | undefined, GitHubApiError, OwnedIdentities>
		/** The `review` commands that count toward the cap on the head, denied ones left out. */
		readonly getCountedReviews: (
			request: CapRequest
		) => Effect.Effect<
			readonly CommentVersion[],
			GitHubApiError,
			OwnedIdentities
		>
	}
>()('mng-review/AnswerReadService') {}

export const AnswerReadServiceLive = Layer.effect(
	AnswerReadService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService
		const reviews = yield* GitHubReviewService
		const risk = yield* GitHubRiskService

		/**
		 * The acted-on rule for one comment's author, with its role read now; only a person's role is
		 * read, since a bot never counts. A confirmed non-collaborator is not acted on.
		 */
		const isActedOn = Effect.fn('AnswerReadService.isActedOn')(function* (
			comment: PullRequestComment
		) {
			const { identities } = yield* OwnedIdentities
			const { author } = comment
			if (author?.__typename !== PERSON_TYPE) return false
			return yield* api.getCollaboratorRole(author.login).pipe(
				Effect.map(role =>
					isActedOnAuthor(
						{ login: author.login, type: author.__typename, viaApp: false },
						role,
						identities.map(identity => identity.login)
					)
				),
				Effect.catchIf(isNotFound, () => Effect.succeed(false))
			)
		})

		/**
		 * True when an app posted the comment on its author's behalf, read from REST, since GraphQL
		 * does not say: such a comment is never acted on. A deleted comment counts as posted by one.
		 */
		const isViaApp = Effect.fn('AnswerReadService.isViaApp')(function* (
			commentId: number
		) {
			return yield* api.getIssueComment(commentId).pipe(
				Effect.map(comment =>
					Predicate.isNotNullish(comment.performed_via_github_app)
				),
				Effect.catchIf(isNotFound, () => Effect.succeed(true))
			)
		})

		const readCommands = Effect.fn('AnswerReadService.readCommands')(function* (
			pullNumber: number
		) {
			const { current } = yield* OwnedIdentities
			const comments = yield* api.listComments(pullNumber)
			const found = comments.flatMap(comment => {
				const command = parseMentionCommand(comment.body, current.login)
				const version = toCommentVersion(comment)
				return command && version ? [{ comment, command, version }] : []
			})
			// One role read per author, not per command; the next read asks again.
			const authors = new Map(
				found.map(entry => [entry.comment.author?.login, entry.comment])
			)
			const standing = new Map(
				yield* Effect.forEach(
					authors,
					([login, comment]) =>
						isActedOn(comment).pipe(
							Effect.map(actedOn => [login, actedOn] as const)
						),
					{ concurrency: 1 }
				)
			)
			// Only a command its author's standing allows needs the app read.
			const commands = yield* Effect.forEach(
				found,
				entry =>
					(standing.get(entry.comment.author?.login) === true
						? isViaApp(entry.version.id).pipe(Effect.map(via => !via))
						: Effect.succeed(false)
					).pipe(
						Effect.map((actedOn): ReadCommand => ({
							...entry.version,
							...(entry.command.agent ? { agent: entry.command.agent } : {}),
							actedOn,
						}))
					),
				{ concurrency: 1 }
			)
			const reviewList = yield* reviews.listReviews(pullNumber)
			const entries = [
				...comments
					.filter(comment => isAppAuthored(comment, current))
					.flatMap(comment => parseAnswerMarker(comment.body)?.answers ?? []),
				...reviewList
					.filter(review => isAppAuthored(review, current))
					.flatMap(review => parseSummaryMarker(review.body)?.answers ?? []),
			]
			return { commands, entries } satisfies CommandRead
		})

		const getCommandEntry = Effect.fn('AnswerReadService.getCommandEntry')(
			function* (request: AnswerRequest) {
				const created = yield* risk.getRunCreated(request.run)
				const { commands, entries } = yield* readCommands(request.pullNumber)
				const need: AnswerNeed =
					request.kind === 'run'
						? { kind: 'run', agent: request.agent ?? '' }
						: { kind: 'review' }
				const unanswered = commands.filter(
					command =>
						command.actedOn &&
						command.at < request.before &&
						command.at < created &&
						command.agent === request.agent &&
						!isAnswered(command, need, entries)
				)
				return toAnswerEntry(
					request.run,
					request.kind,
					unanswered,
					request.agent,
					created
				)
			}
		)

		const getCountedReviewsOnHead = Effect.fn(
			'AnswerReadService.getCountedReviews'
		)(function* (request: CapRequest) {
			const items = yield* risk.listTimeline(request.pullNumber)
			const since = getCommentsSinceHead(items, request.head)
			const { commands, entries } = yield* readCommands(request.pullNumber)
			return getCountedReviews(
				commands
					.filter(command => since.has(command.id))
					.map(command => ({
						...command,
						review: command.agent === undefined,
					})),
				entries
			)
		})

		return {
			readCommands,
			getCommandEntry,
			getCountedReviews: getCountedReviewsOnHead,
		}
	})
)
