import { Config, Console, Effect, FileSystem, Option, Schema } from 'effect'
import type { PublishReport } from '../application/publish-run.service'

/** `GITHUB_OUTPUT`, where a step's outputs go; unset outside a workflow. */
export const outputPathConfig = Config.option(
	Config.String('GITHUB_OUTPUT')
).pipe(Config.map(Option.getOrUndefined))

/** A value safe for one `key=value` output line: no line breaks. */
function toOutputValue(value: string): string {
	return value.replaceAll(/[\r\n]+/gu, ' ')
}

/** Appends step outputs, one `key=value` line each; outside a workflow they are printed. */
export const writeOutputs = Effect.fn('runner.writeOutputs')(function* (
	path: string | undefined,
	outputs: Readonly<Record<string, string>>
) {
	const text = Object.entries(outputs)
		.map(([key, value]) => `${key}=${toOutputValue(value)}\n`)
		.join('')
	if (!path) return yield* Console.log(text)
	const fs = yield* FileSystem.FileSystem
	return yield* fs.writeFileString(path, text, { flag: 'a' })
})

const decodeResult = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
)

/**
 * Sets `publish` in the result file the review job wrote, which the publish job downloaded, and
 * keeps every other key. A missing path, a missing or unreadable file, or a file that is not a
 * JSON object is skipped with a log line; it never fails the step.
 */
export const addPublishToResult = Effect.fn('runner.addPublishToResult')(
	function* (path: string | undefined, publish: PublishReport) {
		if (!path) return yield* Effect.void
		const fs = yield* FileSystem.FileSystem
		const result = yield* fs
			.readFileString(path)
			.pipe(Effect.flatMap(decodeResult), Effect.option)
		if (result._tag === 'None')
			return yield* Console.log(
				'mng-review: the result file is missing or unreadable; publish is not added to it'
			)
		return yield* fs
			.writeFileString(
				path,
				JSON.stringify({ ...result.value, publish }, undefined, 2)
			)
			.pipe(
				Effect.catchTag('PlatformError', error =>
					Console.log(
						`mng-review: the result file cannot be written (${error.reason._tag})`
					)
				)
			)
	}
)
