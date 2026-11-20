/** The comment that may hold a command, as its `issue_comment` event names it. */
export interface CommandComment {
	/** `GITHUB_EVENT_NAME`; only `issue_comment` counts. */
	readonly eventName: string
	/** The event's action; only `created` counts, so an edit never starts a run. */
	readonly action: string
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

/** The two workflow inputs a handle may come from; exactly one is set. */
export interface CommandHandles {
	/** `app-slug`: the app's slug is the handle. */
	readonly appSlug: string
	/** `handle`: the handle of a repository without the app. */
	readonly handle: string
}

/** The handle commands mention, from one of the two inputs. */
export interface ChosenHandle {
	readonly status: 'chosen'
	readonly handle: string
}

/** A command the later jobs may run: the pull request, its two commits and what it asks for. */
export interface AuthorizedCommand {
	readonly status: 'authorized'
	readonly pullNumber: number
	readonly base: string
	readonly head: string
	readonly depth?: 'deep' | 'quick'
	readonly agent?: string
}

/** Why a comment does not start a review. */
export interface DeniedCommand {
	readonly status: 'denied'
	readonly reason: string
}

export type CommandDecision = AuthorizedCommand | DeniedCommand
