import { Effect } from 'effect'
import { decodeConfigValue, parseYamlText } from '../config/config-file.parser'
import { ConfigError } from '../config/config.errors'
import { type BenchFile, benchFileSchema } from './bench-file.schema'

/** Parses a benchmark file; unknown keys, duplicate ids and a missing `version` fail and name the file. */
export function parseBenchFile(
	text: string,
	source: string
): Effect.Effect<BenchFile, ConfigError> {
	return parseYamlText(text, source).pipe(
		Effect.flatMap(raw =>
			raw === null
				? Effect.fail(new ConfigError({ source, reason: 'the file is empty' }))
				: decodeConfigValue(benchFileSchema, raw, source)
		)
	)
}
