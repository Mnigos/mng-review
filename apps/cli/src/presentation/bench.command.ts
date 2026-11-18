import { DEFAULT_LINE_WINDOW } from '@mng-review/domain'
import {
	BenchService,
	BenchServiceLive,
	type BenchRequest,
} from '@mng-review/engine'
import { Console, Effect, Layer, Option } from 'effect'
import { Argument, Command, Flag } from 'effect/cli'
import { formatBenchJson, formatBenchText } from './bench.formatter'
import { CliExit, CONFIG_EXIT_CODE } from './cli-exit.errors'
import { SessionLive } from './plan.command'

const benchFlags = {
	file: Argument.String('file').pipe(
		Argument.withDescription('Benchmark file, version 1 (docs/spec.md)')
	),
	rulesRef: Flag.String('rules-ref').pipe(
		Flag.withDescription(
			'Read .mng/ from this ref instead of the working tree'
		),
		Flag.optional
	),
	lineWindow: Flag.Int('line-window').pipe(
		Flag.withDescription(
			'A finding matches an expected entry on the same path this many lines away or closer'
		),
		Flag.withDefault(DEFAULT_LINE_WINDOW)
	),
	cases: Flag.String('case').pipe(
		Flag.withDescription('Run only the case with this id; repeat for more'),
		Flag.atLeast(0)
	),
	concurrency: Flag.Int('concurrency').pipe(
		Flag.withDescription('Cases reviewed at once'),
		Flag.withDefault(1)
	),
	json: Flag.Boolean('json').pipe(
		Flag.withDescription('Print JSON'),
		Flag.withDefault(false)
	),
} as const

/** Flags of `mng-review bench` after parsing. */
type BenchFlags = Command.Command.Config.Infer<typeof benchFlags>

/** Fails with exit code 2 and `detail`. */
function failConfig(detail: string) {
	return Effect.fail(
		new CliExit({
			code: CONFIG_EXIT_CODE,
			detail: `mng-review bench: ${detail}`,
		})
	)
}

/** The request for the engine, or the flag that is out of range. */
function toBenchRequest(flags: BenchFlags): BenchRequest | string {
	if (flags.lineWindow < 0) return '--line-window must be 0 or more'
	if (flags.concurrency < 1) return '--concurrency must be 1 or more'
	const rulesRef = Option.getOrUndefined(flags.rulesRef)
	return {
		file: flags.file,
		caseIds: flags.cases,
		lineWindow: flags.lineWindow,
		concurrency: flags.concurrency,
		...(rulesRef === undefined ? {} : { rulesRef }),
	}
}

/** Runs the cases, prints the report and exits 2 when a case failed at the endpoint. */
const runBench = Effect.fn('benchCommand')(function* (flags: BenchFlags) {
	const request = toBenchRequest(flags)
	if (typeof request === 'string') return yield* failConfig(request)
	const report = yield* BenchService.use(service => service.run(request))
	yield* Console.log(
		flags.json ? formatBenchJson(report) : formatBenchText(report)
	)
	const failed = report.cases.filter(entry => entry.endpointError)
	if (failed.length > 0)
		return yield* failConfig(
			`model endpoint error in ${failed.map(entry => entry.id).join(', ')}`
		)
	return yield* Effect.void
})

/**
 * `mng-review bench <file>`: replays recorded changes and compares the kept bugs with the expected
 * findings. Exits 0 when the run completes and 2 on a configuration or endpoint error; it never
 * fails on the scores.
 */
export const benchCommand = Command.make('bench', benchFlags, flags =>
	runBench(flags).pipe(
		Effect.provide(BenchServiceLive.pipe(Layer.provide(SessionLive))),
		Effect.catchTags({
			ConfigError: error => failConfig(error.message),
			GitError: error => failConfig(error.message),
		})
	)
).pipe(
	Command.withDescription(
		'Replay recorded changes from a benchmark file and compare the findings with the expected ones.'
	)
)
