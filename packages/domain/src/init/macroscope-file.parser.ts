import { Effect, Predicate, Schema } from 'effect'
import { splitFrontMatter } from '../agents/agent-file.parser'
import { parseYamlText } from '../config/config-file.parser'
import { ConfigError } from '../config/config.errors'
import { formatSchemaIssue } from '../utils/schema-issue.util'
import type { MacroscopeFile } from './init.types'

/** A Macroscope file split into the keys `init` imports, the keys it does not know and the body. */
export interface MacroscopeDocument<TFields> {
	readonly fields: TFields
	/** Front matter keys outside the schema, in file order. */
	readonly otherKeys: readonly string[]
	readonly body: string
}

/** A front matter schema without services: a struct whose field names are the imported keys. */
type MacroscopeSchema = Schema.Decoder<unknown> &
	Pick<Schema.Struct<Schema.Struct.Fields>, 'fields'>

/** A Macroscope file starts with front matter only when its first line is `---`. */
const FRONT_MATTER_START = /^\uFEFF?---[ \t]*\r?$/u

/**
 * Parses a Macroscope Markdown file: decodes the front matter keys `schema` names and lists the
 * others, which `init` reports as dropped. A file without front matter is all body.
 */
export function parseMacroscopeFile<TSchema extends MacroscopeSchema>(
	schema: TSchema,
	file: MacroscopeFile
): Effect.Effect<MacroscopeDocument<TSchema['Type']>, ConfigError> {
	return Effect.gen(function* () {
		const firstLine = file.text.split('\n', 1)[0] ?? ''
		const { yaml, body } = FRONT_MATTER_START.test(firstLine)
			? yield* splitFrontMatter(file.text, file.path)
			: { yaml: '', body: file.text.replaceAll('\r\n', '\n') }
		const raw = (yield* parseYamlText(yaml, file.path)) ?? {}
		if (!Predicate.isObject(raw) || Array.isArray(raw))
			return yield* new ConfigError({
				source: file.path,
				reason: 'front matter must be a mapping',
			})
		const fields = yield* Schema.decodeUnknownEffect(schema, {
			errors: 'all',
		})(raw).pipe(
			Effect.mapError(
				error =>
					new ConfigError({
						source: file.path,
						reason: formatSchemaIssue(error.issue),
					})
			)
		)
		const known = Object.keys(schema.fields)
		const otherKeys = Object.keys(raw).filter(key => !known.includes(key))
		return { fields, otherKeys, body }
	})
}
