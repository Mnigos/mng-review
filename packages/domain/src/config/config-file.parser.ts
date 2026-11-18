import { Effect, Schema, type SchemaAST } from 'effect'
import { Yaml } from 'effect/encoding'
import { formatSchemaIssue } from '../utils/schema-issue.util'
import { ConfigError } from './config.errors'

/** `.mng/` files fail on every unknown key and report every problem at once. */
const CONFIG_PARSE_OPTIONS = {
	errors: 'all',
	onExcessProperty: 'error',
} as const satisfies SchemaAST.ParseOptions

/** Parses YAML text. Empty text or only comments give `null`. */
export const parseYamlText = (text: string, source: string) =>
	Effect.try({
		try: (): unknown => Yaml.parse(text),
		catch: error =>
			new ConfigError({ source, reason: `invalid YAML (${String(error)})` }),
	})

/** Decodes a parsed `.mng/` value with its schema; the error names every offending key by its dotted path. */
export const decodeConfigValue = <TSchema extends Schema.Decoder<unknown>>(
	schema: TSchema,
	value: unknown,
	source: string
) =>
	Schema.decodeUnknownEffect(
		schema,
		CONFIG_PARSE_OPTIONS
	)(value).pipe(
		Effect.mapError(
			error =>
				new ConfigError({ source, reason: formatSchemaIssue(error.issue) })
		)
	)
