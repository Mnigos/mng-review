import { Predicate } from 'effect'

/**
 * Merges `override` into `base`: objects merge key by key, arrays, scalars and `null` replace, and
 * `undefined` keeps the base value. Neither input is modified.
 */
export function deepMerge(base: unknown, override: unknown): unknown {
	if (override === undefined) return base
	if (!(Predicate.isObject(base) && Predicate.isObject(override)))
		return override
	const merged = Object.entries(override)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => [
			key,
			deepMerge(Object.hasOwn(base, key) ? base[key] : undefined, value),
		])
	return Object.fromEntries([...Object.entries(base), ...merged])
}
