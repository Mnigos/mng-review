import { createHash } from 'node:crypto'
import { Predicate } from 'effect'
import type { RiskConfig } from '../../config/review-config.schema'
import {
	ANSWER_DIGEST_LENGTH,
	BUILT_IN_FLOOR_VERSION,
	RULES_DIGEST_LENGTH,
} from '../risk.constants'

/** The sha256 of `text` as lowercase hex. */
function toSha256(text: string): string {
	return createHash('sha256').update(text).digest('hex')
}

/** Objects with their keys sorted, so two equal configs serialize the same in any key order. */
function toSortedKeys(_key: string, value: unknown): unknown {
	if (!Predicate.isObject(value) || Array.isArray(value)) return value
	return Object.fromEntries(
		Object.entries(value).toSorted(([first], [second]) =>
			first < second ? -1 : 1
		)
	)
}

/**
 * The `rules=` field: the first 12 hex characters of a sha256 over the built-in floor version,
 * the resolved rubric with its imports and the merged `risk` keys. A change to any of them changes
 * the digest, so a grant names the rules it was rated under.
 */
export function toRulesDigest(rubric: string, risk: RiskConfig): string {
	const text = JSON.stringify(
		[BUILT_IN_FLOOR_VERSION, rubric, risk],
		toSortedKeys
	)
	return toSha256(text).slice(0, RULES_DIGEST_LENGTH)
}

/**
 * The digest an answer entry carries for a comment: the first 16 hex characters of the sha256 of
 * its whole body, the prefix of the engine's reply digest. Two edits within one second differ in it.
 */
export function toAnswerDigest(body: string): string {
	return toSha256(body).slice(0, ANSWER_DIGEST_LENGTH)
}
