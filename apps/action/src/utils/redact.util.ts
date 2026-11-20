import { REDACTED } from '@mng-review/engine'
import { Predicate } from 'effect'

/** The text with every masked value replaced, longest first so a value that holds another goes whole. */
export function toRedacted(text: string, masked: readonly string[]): string {
	return masked
		.toSorted((a, b) => b.length - a.length)
		.reduce((out, value) => out.replaceAll(value, REDACTED), text)
}

/** Maps keyed by names from the configuration (model names), whose keys are data, not schema. */
const DATA_KEYED_MAPS = new Set(['tokens', 'tokenSources'])

/**
 * The name, or the first of `name (2)`, `name (3)` and so on that no entry holds yet; among
 * `taken.length + 1` suffixes one is always free.
 */
function toFreeKey(name: string, taken: Record<string, unknown>): string {
	if (!Object.hasOwn(taken, name)) return name
	const suffixes = Array.from(
		{ length: Object.keys(taken).length + 1 },
		(_, index) => `${name} (${index + 2})`
	)
	return suffixes.find(key => !Object.hasOwn(taken, key)) ?? name
}

/**
 * A JSON value with the masked values replaced in strings and in the keys of the maps keyed by
 * model names; names that become equal get a ` (2)`, ` (3)` suffix so no entry is lost. Schema keys,
 * numbers, booleans and arrays pass through; `JSON.stringify` visits the members. Used as its
 * replacer for the result file and the outcome file.
 */
export function toRedactedValue(
	key: string,
	value: unknown,
	masked: readonly string[]
): unknown {
	if (Predicate.isString(value)) return toRedacted(value, masked)
	if (!DATA_KEYED_MAPS.has(key) || !Predicate.isObject(value)) return value
	return Object.entries(value).reduce<Record<string, unknown>>(
		(out, [name, member]) => {
			out[toFreeKey(toRedacted(name, masked), out)] = member
			return out
		},
		{}
	)
}
