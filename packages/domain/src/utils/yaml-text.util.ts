import { Predicate } from 'effect'

/** A value `toYamlText` can write: strings, numbers, booleans, lists and mappings of them. */
export type YamlValue =
	| string
	| number
	| boolean
	| readonly YamlValue[]
	| YamlMapping

/** A mapping with string keys; keys keep their insertion order. */
export interface YamlMapping {
	readonly [key: string]: YamlValue
}

const INDENT = '  '
/**
 * Plain scalars YAML reads back as the same string: words, dots, slashes and dashes with single
 * inner spaces, no reserved words and no numbers.
 */
const PLAIN_SCALAR = /^[A-Za-z_][\w./-]*(?: [\w./-]+)*$/u
const RESERVED_WORDS = /^(?:true|false|yes|no|on|off|null|y|n)$/iu

/** A string as a YAML scalar: plain when that reads back unchanged, single-quoted otherwise. */
function toScalar(value: string): string {
	if (PLAIN_SCALAR.test(value) && !RESERVED_WORDS.test(value)) return value
	return `'${value.replaceAll("'", "''")}'`
}

/** The lines of one value under a key or list dash, indented by `depth`. */
function toLines(value: YamlValue, depth: number): string[] {
	const indent = INDENT.repeat(depth)
	if (Predicate.isString(value)) return [toScalar(value)]
	if (Predicate.isNumber(value) || Predicate.isBoolean(value))
		return [String(value)]
	if (Array.isArray(value)) {
		const items: readonly YamlValue[] = value
		if (items.length === 0) return ['[]']
		return items.flatMap(item => {
			const [first = '', ...rest] = toLines(item, depth + 1)
			return [`${indent}- ${first.trimStart()}`, ...rest]
		})
	}
	const entries = Object.entries(value)
	if (entries.length === 0) return ['{}']
	return entries.flatMap(([key, item]) => {
		const lines = toLines(item, depth + 1)
		const nested = lines.length > 1 || lines[0]?.startsWith(INDENT)
		if (nested) return [`${indent}${toScalar(key)}:`, ...lines]
		return [`${indent}${toScalar(key)}: ${lines[0] ?? ''}`]
	})
}

/**
 * Writes a mapping as block-style YAML that `Yaml.parse` reads back to the same value. Lists and
 * mappings nest by indentation; strings are quoted only when a plain scalar would read differently.
 */
export function toYamlText(value: YamlMapping): string {
	return `${toLines(value, 0).join('\n')}\n`
}
