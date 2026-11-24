import {
	isActedOnAuthor,
	PERSON_TYPE,
	type ReviewConfig,
} from '@mng-review/domain'
import { Context, Effect, Layer } from 'effect'
import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import { isNotFound } from '../../../platform/github-api.helper'
import { GitHubApiService } from '../../../platform/github-api.service'
import type { GitHubApiError } from '../../../platform/github.errors'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import { escapeMarkdown } from '../../../utils/markdown.util'
import type {
	CommandComment,
	CommandDecision,
} from '../../command/domain/command.types'
import { parseMentionCommand } from '../../command/domain/mention-command.parser'
import { MARKER_VERSION } from '../../publish/domain/publish.constants'
import { toMarkerComment } from '../../publish/presentation/thread-comment.formatter'
import { toAnswerEntry } from '../domain/answer.helper'
import { isOverCap } from '../domain/command-cap.helper'
import { toCommentVersion } from '../domain/reply-answer.helper'
import type { Refusal } from '../domain/risk.types'
import { AnswerReadService } from './answer-read.service'

/** What the cap and the denial rule decide on. */
export interface CommandCheckInput {
	readonly comment: CommandComment
	readonly decision: CommandDecision
	readonly config: Pick<ReviewConfig, 'risk'>
}

/** The reason an edited command shows; an edit never runs a command. */
const EDITED_REASON = 'the comment changed; post a new command'

/**
 * With `risk.enabled`, the decide job's two extra rules: a command line from an acted-on author
 * that any check refused gets a denial answer, so every comment that can hold the pull request also
 * gets an answer; and a `review` command past `risk.reviews_per_head` on the head is refused with a
 * cap reply before any job enters the group. The denial job posts both as new comments whose
 * answer marker names the command at the version it read. A confirmed non-collaborator (a 404 on
 * the role read) is not acted on; any other failed role or cap read fails the check, so the decide
 * job fails instead of passing with no answer, and the design allows it one repeat.
 */
export class CommandAnswerService extends Context.Service<
	CommandAnswerService,
	{
		readonly check: (
			input: CommandCheckInput
		) => Effect.Effect<CommandDecision, GitHubApiError, OwnedIdentities>
		/** Posts the refusal; a comment that no longer holds the command is not answered. */
		readonly post: (
			refusal: Refusal
		) => Effect.Effect<boolean, GitHubApiError, OwnedIdentities>
	}
>()('mng-review/CommandAnswerService') {}

export const CommandAnswerServiceLive = Layer.effect(
	CommandAnswerService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService
		const answers = yield* AnswerReadService

		/**
		 * The acted-on rule for the commenter (`isActedOnAuthor`), its role read only for a person; a
		 * confirmed non-collaborator is not acted on.
		 */
		const isActedOn = Effect.fn('CommandAnswerService.isActedOn')(function* (
			comment: CommandComment
		) {
			const { identities } = yield* OwnedIdentities
			const author = {
				login: comment.login,
				type: comment.type,
				viaApp: comment.viaApp,
			}
			if (comment.type !== PERSON_TYPE || comment.viaApp) return false
			return yield* api.getCollaboratorRole(comment.login).pipe(
				Effect.map(role =>
					isActedOnAuthor(
						author,
						role,
						identities.map(identity => identity.login)
					)
				),
				Effect.catchIf(isNotFound, () => Effect.succeed(false))
			)
		})

		const check = Effect.fn('CommandAnswerService.check')(function* (
			input: CommandCheckInput
		) {
			const { comment, decision, config } = input
			const { current } = yield* OwnedIdentities
			// The job token never rates, so it neither caps nor answers for the rating.
			if (
				!config.risk.enabled ||
				current.login === GITHUB_ACTIONS_IDENTITY.login
			)
				return decision
			const command = parseMentionCommand(comment.body, current.login)
			if (!command || !comment.onPullRequest) return decision
			if (!(yield* isActedOn(comment))) return decision
			const refused = {
				pullNumber: comment.issueNumber,
				commentId: comment.id,
			}
			if (decision.status === 'denied')
				return {
					...decision,
					...refused,
					answer: 'deny',
					...(comment.action === 'edited' ? { reason: EDITED_REASON } : {}),
				} satisfies CommandDecision
			if (decision.agent !== undefined) return decision
			const counted = yield* answers.getCountedReviews({
				pullNumber: decision.pullNumber,
				head: decision.head,
				commentId: comment.id,
				cap: config.risk.reviews_per_head,
			})
			if (!isOverCap(counted, comment.id, config.risk.reviews_per_head))
				return decision
			return {
				status: 'denied',
				reason: `risk.reviews_per_head reached (${config.risk.reviews_per_head}); push to rate the head again`,
				...refused,
				answer: 'cap',
			} satisfies CommandDecision
		})

		const post = Effect.fn('CommandAnswerService.post')(function* (
			refusal: Refusal
		) {
			const { current } = yield* OwnedIdentities
			const comments = yield* api.listComments(refusal.pullNumber)
			const comment = comments.find(
				entry => entry.databaseId === refusal.commentId
			)
			const version = comment && toCommentVersion(comment)
			if (!version || !parseMentionCommand(version.body, current.login))
				return false
			const entry = toAnswerEntry(refusal.run, refusal.kind, [version])
			const text =
				refusal.kind === 'cap'
					? `This head was rated as often as \`risk.reviews_per_head\` allows: ${escapeMarkdown(refusal.reason)}.`
					: `Not run: ${escapeMarkdown(refusal.reason)}.`
			yield* api.createIssueComment(
				refusal.pullNumber,
				`${text}\n\n${toMarkerComment('answer', { v: MARKER_VERSION, answers: entry ? [entry] : [] })}`
			)
			return true
		})

		return { check, post }
	})
)
