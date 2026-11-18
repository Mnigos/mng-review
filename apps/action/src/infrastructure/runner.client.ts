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
}

/** Reads the runner's variables; an unset one is empty or `undefined`, never an error. */
export const runnerEnvironmentConfig = Config.all({
	eventName: Config.String('GITHUB_EVENT_NAME').pipe(Config.withDefault('')),
	eventPath: Config.option(Config.String(EVENT_PATH_VARIABLE)),
	summaryPath: Config.option(Config.String('GITHUB_STEP_SUMMARY')),
	engineCommit: Config.option(Config.String('MNG_REVIEW_ENGINE_COMMIT')),
}).pipe(
	Config.map((settings): RunnerEnvironment => ({
		eventName: settings.eventName.trim(),
		eventPath: Option.getOrUndefined(settings.eventPath),
		summaryPath: Option.getOrUndefined(settings.summaryPath),
		engineCommit: Option.getOrUndefined(settings.engineCommit)?.trim(),
	}))
)

/** Every form of the endpoint that could reach a log: the URL, its origin and host, and the key. */
function toMaskedValues(url: string, key: string): string[] {
	const parsed = URL.canParse(url) ? new URL(url) : undefined
	const forms = [url, key, parsed?.origin ?? '', parsed?.host ?? '']
	return [...new Set(forms.flatMap(form => form.split(/\r?\n/u)))].filter(
		form => form.trim().length > 0
	)
}

/**
 * Registers the endpoint's URL and key with the runner's `::add-mask::` command, so neither can
 * appear in the job log even if a later message carried one. Unset values are skipped.
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
	yield* Effect.forEach(toMaskedValues(url, key), value =>
		Console.log(`::add-mask::${value}`)
	)
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
