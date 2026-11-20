import { commitShaSchema } from '@mng-review/domain'
import { APP_SLUG_VARIABLE, type CommandHandles } from '@mng-review/github'
import { Config, Option } from 'effect'

export const TRIGGER_VARIABLE = 'MNG_REVIEW_TRIGGER'
export const HANDLE_VARIABLE = 'MNG_REVIEW_HANDLE'
export const RUN_TRIGGERS = ['push', 'command'] as const
export type RunTrigger = (typeof RUN_TRIGGERS)[number]
/** The depths a command may ask for; empty asks for none. */
const COMMAND_DEPTHS = ['deep', 'quick', ''] as const

/**
 * `MNG_REVIEW_TRIGGER`: what started the run, `push` (the default, a pull request event) or
 * `command` (an authorized mention command). Any other value is a configuration error.
 */
export const triggerConfig = Config.Literals(
	RUN_TRIGGERS,
	TRIGGER_VARIABLE
).pipe(Config.withDefault('push' as RunTrigger))

/** The run an authorized command asked for, passed on from the authorize job's outputs. */
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
