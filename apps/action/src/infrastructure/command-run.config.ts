import { commitShaSchema, positiveIntSchema } from '@mng-review/domain'
import { APP_SLUG_VARIABLE, type CommandHandles } from '@mng-review/github'
import { Config, Option } from 'effect'

export const TRIGGER_VARIABLE = 'MNG_REVIEW_TRIGGER'
export const HANDLE_VARIABLE = 'MNG_REVIEW_HANDLE'
export const RUN_TRIGGERS = ['push', 'command', 'converse'] as const
export type RunTrigger = (typeof RUN_TRIGGERS)[number]
/** The depths a command may ask for; empty asks for none. */
const COMMAND_DEPTHS = ['deep', 'quick', ''] as const

/**
 * `MNG_REVIEW_TRIGGER`: what started the run, `push` (the default, a pull request event),
 * `command` (an authorized mention command) or `converse` (the reply schedule, which answers
 * replies and reviews nothing). Any other value is a configuration error.
 */
export const triggerConfig = Config.Literals(
	RUN_TRIGGERS,
	TRIGGER_VARIABLE
).pipe(Config.withDefault('push' as RunTrigger))

/** Pull requests one tick of the reply schedule answers when the caller sets none. */
const DEFAULT_MAX_PULL_REQUESTS = 5

/** `MNG_REVIEW_MAX_PULL_REQUESTS`: how many pull requests the find step keeps; a whole number above 0. */
export const maxPullRequestsConfig = Config.schema(
	positiveIntSchema,
	'MNG_REVIEW_MAX_PULL_REQUESTS'
).pipe(Config.withDefault(DEFAULT_MAX_PULL_REQUESTS))

/**
 * `GITHUB_RUN_NUMBER`, 0 outside a workflow: a reply schedule's tick, which shifts the batch of
 * pull requests and replies when more wait than one run answers, since a reply-only run never
 * advances the summary's run count.
 */
export const runNumberConfig = Config.Int('GITHUB_RUN_NUMBER').pipe(
	Config.withDefault(0)
)

/**
 * The run an authorized command asked for, passed on from the authorize job's outputs; for the
 * reply schedule, the pull request and commits the find step listed.
 */
export interface CommandTarget {
	readonly pullNumber: number
	/** The commits the authorize job checked; the later jobs check out and fetch these. */
	readonly base: string
	readonly head: string
	readonly depth: 'deep' | 'quick' | undefined
	readonly agent: string | undefined
}

/**
 * Reads `MNG_REVIEW_TARGET_PR`, `_BASE` and `_HEAD`, and `MNG_REVIEW_COMMAND_DEPTH` and `_AGENT`;
 * a missing or malformed number or commit fails, and a depth other than `deep`, `quick` or empty
 * fails.
 */
export const commandTargetConfig = Config.all({
	pullNumber: Config.Int('MNG_REVIEW_TARGET_PR'),
	base: Config.schema(commitShaSchema, 'MNG_REVIEW_TARGET_BASE'),
	head: Config.schema(commitShaSchema, 'MNG_REVIEW_TARGET_HEAD'),
	depth: Config.Literals(COMMAND_DEPTHS, 'MNG_REVIEW_COMMAND_DEPTH').pipe(
		Config.withDefault('' as const)
	),
	agent: Config.option(Config.String('MNG_REVIEW_COMMAND_AGENT')),
}).pipe(
	Config.map((settings): CommandTarget => ({
		pullNumber: settings.pullNumber,
		base: settings.base,
		head: settings.head,
		depth: settings.depth || undefined,
		agent: Option.getOrUndefined(settings.agent)?.trim() || undefined,
	}))
)

/** `MNG_REVIEW_APP_SLUG` and `MNG_REVIEW_HANDLE`, the two inputs a handle may come from. */
export const commandHandlesConfig = Config.all({
	appSlug: Config.String(APP_SLUG_VARIABLE).pipe(Config.withDefault('')),
	handle: Config.String(HANDLE_VARIABLE).pipe(Config.withDefault('')),
}).pipe(Config.map((handles): CommandHandles => handles))

/** `MNG_REVIEW_TARGET_PR`: the pull request the reply schedule's lift job judges, from the find job. */
export const liftTargetConfig = Config.Int('MNG_REVIEW_TARGET_PR')
