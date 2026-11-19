import { ConfigError } from '@mng-review/domain'
import { LLM_KEY_VARIABLE, LLM_URL_VARIABLE } from '@mng-review/engine'
import { Config, Console, Effect, FileSystem, Option, Redacted } from 'effect'
import { EVENT_PATH_VARIABLE } from './pull-request-event.parser'

/** What the runner tells the entry through the environment. */
export interface RunnerEnvironment {
	/** `GITHUB_EVENT_NAME`, empty outside a workflow. */
	readonly eventName: string
	readonly eventPath: string | undefined
	/** `GITHUB_STEP_SUMMARY`; unset outside a workflow, where the summary goes to stdout. */
	readonly summaryPath: string | undefined
	/** `MNG_REVIEW_ENGINE_COMMIT`, the reusable workflow's own commit. */
	readonly engineCommit: string | undefined
	/** `MNG_REVIEW_RESULT_PATH`, where the result file goes; unset, no file is written. */
	readonly resultPath: string | undefined
	/** `GITHUB_REPOSITORY`, `owner/name` of the caller. */
	readonly repository: string | undefined
	readonly runId: string | undefined
	readonly runAttempt: string | undefined
}

/**
 * The caller's checkout git reads: `MNG_REVIEW_REPO_DIR`, or the working directory outside a
 * workflow. The workflow starts Bun in the engine's own directory, so no `bunfig.toml`, `.env` or
 * `tsconfig.json` of the reviewed repository is ever loaded.
 */
export const repoDirConfig = Config.String('MNG_REVIEW_REPO_DIR').pipe(
	Config.withDefault(process.cwd())
)

export const MODE_VARIABLE = 'MNG_REVIEW_MODE'
export const RUN_MODES = ['shadow', 'publish', 'sweep'] as const
export type RunMode = (typeof RUN_MODES)[number]

/**
 * `MNG_REVIEW_MODE`: `shadow` (the default) writes the job summary only, `publish` also posts on
 * the pull request, `sweep` reviews nothing and refreshes the `MNG Review` status of open pull
 * requests. Any other value fails, before the review spends anything.
 */
export const modeConfig = Config.Literals(RUN_MODES, MODE_VARIABLE).pipe(
	Config.withDefault('shadow' as RunMode)
)

/** Reads the runner's variables; an unset one is empty or `undefined`, never an error. */
export const runnerEnvironmentConfig = Config.all({
	eventName: Config.String('GITHUB_EVENT_NAME').pipe(Config.withDefault('')),
	eventPath: Config.option(Config.String(EVENT_PATH_VARIABLE)),
	summaryPath: Config.option(Config.String('GITHUB_STEP_SUMMARY')),
	engineCommit: Config.option(Config.String('MNG_REVIEW_ENGINE_COMMIT')),
	resultPath: Config.option(Config.String('MNG_REVIEW_RESULT_PATH')),
	repository: Config.option(Config.String('GITHUB_REPOSITORY')),
	runId: Config.option(Config.String('GITHUB_RUN_ID')),
	runAttempt: Config.option(Config.String('GITHUB_RUN_ATTEMPT')),
}).pipe(
	Config.map((settings): RunnerEnvironment => ({
		eventName: settings.eventName.trim(),
		eventPath: Option.getOrUndefined(settings.eventPath),
		summaryPath: Option.getOrUndefined(settings.summaryPath),
		engineCommit: Option.getOrUndefined(settings.engineCommit)?.trim(),
		resultPath: Option.getOrUndefined(settings.resultPath)?.trim() || undefined,
		repository: Option.getOrUndefined(settings.repository)?.trim(),
		runId: Option.getOrUndefined(settings.runId)?.trim(),
		runAttempt: Option.getOrUndefined(settings.runAttempt)?.trim(),
	}))
)

/** Every form of the endpoint that could reach a log: the URL, its origin, host and hostname, and the key as read and trimmed. */
function toMaskedValues(url: string, key: string): string[] {
	const parsed = URL.canParse(url) ? new URL(url) : undefined
	const forms = [
		url,
		key,
		key.trim(),
		parsed?.origin ?? '',
		parsed?.host ?? '',
		parsed?.hostname ?? '',
	]
	return [...new Set(forms.flatMap(form => form.split(/\r?\n/u)))].filter(
		form => form.trim().length > 0
	)
}

/**
 * Registers the endpoint's URL and key with the runner's `::add-mask::` command, so neither can
 * appear in the job log even if a later message carried one. Unset values are skipped. Returns the
 * masked values, which the result file is redacted with.
 */
export const maskEndpoint = Effect.fn('runner.maskEndpoint')(function* () {
	const settings = yield* Config.all({
		url: Config.option(Config.String(LLM_URL_VARIABLE)),
		key: Config.option(Config.Redacted(LLM_KEY_VARIABLE)),
	}).pipe(
		Effect.orElseSucceed(() => ({ url: Option.none(), key: Option.none() }))
	)
	const url = Option.getOrElse(settings.url, () => '').trim()
	const key = Option.match(settings.key, {
		onNone: () => '',
		onSome: Redacted.value,
	})
	const values = toMaskedValues(url, key)
	for (const value of values) yield* Console.log(`::add-mask::${value}`)
	return values
})

/** The event payload as text; a missing path or an unreadable file fails naming `GITHUB_EVENT_PATH`. */
export const readEventText = Effect.fn('runner.readEventText')(function* (
	path: string | undefined
) {
	if (!path)
		return yield* new ConfigError({
			source: EVENT_PATH_VARIABLE,
			reason: 'is not set',
		})
	const fs = yield* FileSystem.FileSystem
	return yield* fs.readFileString(path).pipe(
		Effect.mapError(
			error =>
				new ConfigError({
					source: EVENT_PATH_VARIABLE,
					reason: `cannot be read (${error.reason._tag})`,
				})
		)
	)
})

/** Appends the summary to the job summary file, or prints it outside a workflow. */
export const writeSummary = Effect.fn('runner.writeSummary')(function* (
	path: string | undefined,
	markdown: string
) {
	if (!path) return yield* Console.log(markdown)
	const fs = yield* FileSystem.FileSystem
	return yield* fs.writeFileString(path, markdown, { flag: 'a' })
})

/** Writes the result file; outside a workflow, with no path, nothing is written. */
export const writeResult = Effect.fn('runner.writeResult')(function* (
	path: string | undefined,
	json: string
) {
	if (!path) return yield* Effect.void
	const fs = yield* FileSystem.FileSystem
	return yield* fs.writeFileString(path, json)
})
