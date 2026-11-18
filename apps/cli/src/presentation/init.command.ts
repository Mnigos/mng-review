import {
	GitServiceLive,
	InitService,
	InitServiceLive,
} from '@mng-review/engine'
import { Console, Effect, Layer } from 'effect'
import { Command, Flag } from 'effect/cli'
import { CliExit, CONFIG_EXIT_CODE } from './cli-exit.errors'
import { formatInitText } from './init.formatter'

const initFlags = {
	fromMacroscope: Flag.Boolean('from-macroscope').pipe(
		Flag.withDescription(
			'Build .mng/ from the .macroscope/ folder of this repository; .macroscope/ is left as it is'
		),
		Flag.withDefault(false)
	),
	force: Flag.Boolean('force').pipe(
		Flag.withDescription('Write over the files of an existing .mng/'),
		Flag.withDefault(false)
	),
} as const

/** Flags of `mng-review init` after parsing. */
type InitFlags = Command.Command.Config.Infer<typeof initFlags>

/** Writes `.mng/` and prints what was written and what could not be carried over. */
const runInit = Effect.fn('initCommand')(function* (flags: InitFlags) {
	const report = yield* InitService.use(service =>
		service.init({ fromMacroscope: flags.fromMacroscope, force: flags.force })
	)
	yield* Console.log(formatInitText(report))
})

/** Fails with exit code 2 and the error's message. */
function toConfigExit(error: Error) {
	return Effect.fail(
		new CliExit({
			code: CONFIG_EXIT_CODE,
			detail: `mng-review init: ${error.message}`,
		})
	)
}

/**
 * `mng-review init`: writes a starter `.mng/`, or one built from `.macroscope/` with
 * `--from-macroscope`. Refuses an existing `.mng/` without `--force`; exits 2 when it writes nothing.
 */
export const initCommand = Command.make('init', initFlags, flags =>
	runInit(flags).pipe(
		Effect.provide(InitServiceLive.pipe(Layer.provide(GitServiceLive))),
		Effect.catchTags({
			InitError: toConfigExit,
			ConfigError: toConfigExit,
			GitError: toConfigExit,
		})
	)
).pipe(
	Command.withDescription(
		'Write a starter .mng/ with review.yml, CONTEXT.md, MEMORY.md and two example agents, or build it from .macroscope/ with --from-macroscope.'
	)
)
