import type { Rules } from '@mng-review/engine'
import { Context, Effect, Layer } from 'effect'
import { GitHubApiService } from '../../../platform/github-api.service'
import { PublishService } from '../../publish/application/publish.service'
import { parseReviewCommand } from '../domain/command.parser'

/** A full commit SHA, SHA-1 or SHA-256; anything else never reaches a later job's git call. */
const COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u
/** Roles that may always start a review with a command. */
const ADMIN_ROLES = ['admin'] as const
/** Roles a login listed in `commands.allow` must still have; a renamed or removed login drops out. */
const ALLOWED_ROLES = ['admin', 'maintain', 'write'] as const

/** The comment that may hold a command, as the `issue_comment` event names it. */
export interface CommandComment {
	readonly id: number
	readonly body: string
	readonly login: string
	/** `User`, `Bot` or `Organization`; only a `User` may start a review. */
	readonly type: string
	/** Set when an app posted the comment on a person's behalf. */
	readonly viaApp: boolean
	readonly issueNumber: number
	readonly onPullRequest: boolean
}

/** A command the entry may run: the pull request, its two commits and what it asks for. */
export interface AuthorizedCommand {
	readonly status: 'authorized'
	readonly pullNumber: number
	readonly base: string
	readonly head: string
	readonly depth?: 'deep'
	readonly agent?: string
}

/** Why a comment does not start a review. */
export interface DeniedCommand {
	readonly status: 'denied'
	readonly reason: string
}

export type CommandDecision = AuthorizedCommand | DeniedCommand

/** A denial with its reason. */
function deny(reason: string): DeniedCommand {
	return { status: 'denied', reason }
}

/**
 * Decides whether a pull request comment starts a review, before any secret or model is used: a
 * `/mng-review` command (alone on its line, outside code blocks) in a comment a person wrote, still
 * there and unchanged when read again, by an admin of the repository or a login in
 * `commands.allow` that still has write access, naming a declared agent if any, on an open pull
 * request from this repository that has not used up `commands.max_runs`. Any GitHub error denies.
 */
export class CommandAuthorizeService extends Context.Service<
	CommandAuthorizeService,
	{
		readonly authorize: (
			comment: CommandComment,
			rules: Pick<Rules, 'config' | 'agents'>
		) => Effect.Effect<CommandDecision>
	}
>()('mng-review/CommandAuthorizeService') {}

export const CommandAuthorizeServiceLive = Layer.effect(
	CommandAuthorizeService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService
		const publisher = yield* PublishService

		/** True when the commenter may start a review. */
		const isAllowed = Effect.fn('CommandAuthorizeService.isAllowed')(function* (
			login: string,
			allow: readonly string[]
		) {
			const role = yield* api.getCollaboratorRole(login)
			const admins: readonly string[] = ADMIN_ROLES
			const writers: readonly string[] = ALLOWED_ROLES
			return (
				admins.includes(role) ||
				(allow.includes(login) && writers.includes(role))
			)
		})

		const decide = Effect.fn('CommandAuthorizeService.decide')(function* (
			comment: CommandComment,
			rules: Pick<Rules, 'config' | 'agents'>
		) {
			if (!comment.onPullRequest)
				return deny('the comment is not on a pull request')
			if (comment.type !== 'User' || comment.viaApp)
				return deny('only a person can start a review')
			const command = parseReviewCommand(comment.body)
			if (!command) return deny('the comment holds no /mng-review command')
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
			if (!COMMIT_SHA.test(pr.base.sha) || !COMMIT_SHA.test(pr.head.sha))
				return deny('the pull request has no valid commits')
			const prior = yield* publisher.readPrior(comment.issueNumber)
			if ((prior?.manualRuns ?? 0) >= commands.max_runs)
				return deny(`commands.max_runs reached (${commands.max_runs})`)
			return {
				status: 'authorized',
				pullNumber: pr.number,
				base: pr.base.sha,
				head: pr.head.sha,
				...(command.depth ? { depth: command.depth } : {}),
				...(command.agent ? { agent: command.agent } : {}),
			} satisfies AuthorizedCommand
		})

		const authorize = Effect.fn('CommandAuthorizeService.authorize')(function* (
			comment: CommandComment,
			rules: Pick<Rules, 'config' | 'agents'>
		) {
			return yield* decide(comment, rules).pipe(
				Effect.catchTag('GitHubApiError', error =>
					Effect.succeed(deny(`GitHub refused a check: ${error.message}`))
				)
			)
		})

		return { authorize }
	})
)
