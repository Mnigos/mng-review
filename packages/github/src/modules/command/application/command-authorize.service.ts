import { commitShaSchema } from '@mng-review/domain'
import type { Rules } from '@mng-review/engine'
import { Context, Effect, Layer, Schema } from 'effect'
import { GitHubApiService } from '../../../platform/github-api.service'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import { SummaryCommentService } from '../../publish/application/summary-comment.service'
import { isOwnerAccess } from '../domain/command-access.helper'
import { getCommandHandle } from '../domain/command-handle.helper'
import type {
	AuthorizedCommand,
	CommandComment,
	CommandDecision,
	CommandHandles,
	DeniedCommand,
} from '../domain/command.types'
import { parseMentionCommand } from '../domain/mention-command.parser'

const isCommitSha = Schema.is(commitShaSchema)

/** What the authorize step decides on: the comment, the handle inputs and the default branch's rules. */
export interface AuthorizeInput {
	readonly comment: CommandComment
	readonly handles: CommandHandles
	readonly rules: Pick<Rules, 'config' | 'agents'>
}

/** A denial with its reason. */
function deny(reason: string): DeniedCommand {
	return { status: 'denied', reason }
}

/** Why the comment's event or author can never start a review, or `undefined`. */
function getAuthorDenial(
	comment: CommandComment,
	restLogins: readonly string[]
): string | undefined {
	if (comment.eventName !== 'issue_comment' || comment.action !== 'created')
		return 'only a new pull request comment starts a review; edits never do'
	if (!comment.onPullRequest) return 'the comment is not on a pull request'
	if (
		comment.type !== 'User' ||
		comment.viaApp ||
		restLogins.includes(comment.login.toLowerCase())
	)
		return 'only a person can start a review'
	return undefined
}

/**
 * Decides whether a pull request comment starts a review, before any secret or model is used: a
 * new comment a person wrote, with a mention command for the configured handle, still unchanged
 * when read again, by an admin or a login in `commands.allow` that still has write access, naming
 * a declared agent if any, on an open pull request from this repository with full commits, below
 * `commands.max_runs` counted over the owned identities' summary. Any GitHub error denies.
 */
export class CommandAuthorizeService extends Context.Service<
	CommandAuthorizeService,
	{
		readonly authorize: (
			input: AuthorizeInput
		) => Effect.Effect<CommandDecision, never, OwnedIdentities>
	}
>()('mng-review/CommandAuthorizeService') {}

export const CommandAuthorizeServiceLive = Layer.effect(
	CommandAuthorizeService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService
		const summaries = yield* SummaryCommentService

		/**
		 * True when the commenter may start a review: the built-in `admin` role, never a custom one, or
		 * a login in `commands.allow` that still has write access.
		 */
		const isAllowed = Effect.fn('CommandAuthorizeService.isAllowed')(function* (
			login: string,
			allow: readonly string[]
		) {
			return isOwnerAccess(login, yield* api.getCollaboratorRole(login), allow)
		})

		const decide = Effect.fn('CommandAuthorizeService.decide')(function* (
			input: AuthorizeInput
		) {
			const { comment, rules } = input
			const { identities } = yield* OwnedIdentities
			const author = getAuthorDenial(
				comment,
				identities.map(identity => identity.restLogin)
			)
			if (author !== undefined) return deny(author)
			const chosen = getCommandHandle(input.handles)
			if (chosen.status === 'denied') return chosen
			const command = parseMentionCommand(comment.body, chosen.handle)
			if (!command) return deny('the comment holds no command')
			const current = yield* api.getIssueComment(comment.id)
			if (current.body !== comment.body)
				return deny('the comment changed since it was posted')
			const { commands } = rules.config
			if (!(yield* isAllowed(comment.login, commands.allow)))
				return deny('the commenter is not an admin and not in commands.allow')
			if (
				command.agent !== undefined &&
				!rules.agents.some(agent => agent.name === command.agent)
			)
				return deny(`no declared agent is named ${command.agent}`)
			const pr = yield* api.getPullRequest(comment.issueNumber)
			if (pr.state !== 'open') return deny('the pull request is not open')
			if (pr.head.repo?.full_name !== pr.base.repo.full_name)
				return deny('the pull request comes from a fork')
			if (!isCommitSha(pr.base.sha) || !isCommitSha(pr.head.sha))
				return deny('the pull request has no valid commits')
			const prior = yield* summaries.readPrior(comment.issueNumber)
			if ((prior?.manualRuns ?? 0) >= commands.max_runs)
				return deny(`commands.max_runs reached (${commands.max_runs})`)
			return {
				status: 'authorized',
				pullNumber: pr.number,
				base: pr.base.sha,
				head: pr.head.sha,
				...command,
			} satisfies AuthorizedCommand
		})

		const authorize = Effect.fn('CommandAuthorizeService.authorize')(function* (
			input: AuthorizeInput
		) {
			return yield* decide(input).pipe(
				Effect.catchTag('GitHubApiError', error =>
					Effect.succeed(deny(`GitHub refused a check: ${error.message}`))
				)
			)
		})

		return { authorize }
	})
)
