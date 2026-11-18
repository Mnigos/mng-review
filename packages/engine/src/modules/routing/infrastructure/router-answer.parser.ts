import type {
	DeclaredAgent,
	RouterAddition,
	RouterReport,
} from '@mng-review/domain'
import { Effect, Schema } from 'effect'
import {
	type RouterAdditionAnswer,
	type RouterAnswer,
	routerAnswerSchema,
} from '../domain/router-answer.schema'
import { RouterAnswerError } from '../domain/routing.errors'

/** A whole answer wrapped in one code fence; only that outer fence is removed. */
const OUTER_FENCE = /^\s*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n[ \t]*\1[ \t]*\s*$/u

/** A successful router report: the risk and the additions that survived validation. */
type RoutedReport = Required<Pick<RouterReport, 'risk'>> &
	Pick<RouterReport, 'added'> & { readonly status: 'ok' }

/** Removes one fence around the whole text; backticks inside the JSON stay. */
export function stripOuterFence(text: string): string {
	return (OUTER_FENCE.exec(text)?.[2] ?? text).trim()
}

/**
 * Keeps additions of candidate agents only, once each, with a non-empty reason, trimmed. The
 * router can add agents; anything else it names is dropped.
 */
export function getValidAdditions(
	add: readonly RouterAdditionAnswer[],
	candidates: readonly Pick<DeclaredAgent, 'name'>[]
): RouterAddition[] {
	const names = new Set(candidates.map(candidate => candidate.name))
	const kept: RouterAddition[] = []
	for (const { agent, reason } of add) {
		const trimmed = reason.trim()
		if (!(names.has(agent) && trimmed)) continue
		if (kept.some(entry => entry.agent === agent)) continue
		kept.push({ agent, reason: trimmed })
	}
	return kept
}

/** Decodes the `route` tool's arguments. */
function decodeToolArguments(
	params: unknown
): Effect.Effect<RouterAnswer, RouterAnswerError> {
	return Schema.decodeUnknownEffect(routerAnswerSchema)(params).pipe(
		Effect.mapError(
			() => new RouterAnswerError({ reason: 'did not match the schema' })
		)
	)
}

/** Decodes a JSON text answer, with or without one outer code fence. */
function decodeTextAnswer(
	text: string
): Effect.Effect<RouterAnswer, RouterAnswerError> {
	const json = stripOuterFence(text)
	if (!json) return Effect.fail(new RouterAnswerError({ reason: 'was empty' }))
	return Schema.decodeUnknownEffect(Schema.fromJsonString(routerAnswerSchema))(
		json
	).pipe(
		Effect.mapError(
			() =>
				new RouterAnswerError({
					reason: 'was not JSON matching the schema',
				})
		)
	)
}

/**
 * Parses the router's answer: the `route` tool call when there is one, otherwise the text. Unknown
 * or repeated agents and empty reasons are dropped.
 */
export function parseRouterAnswer(
	toolArguments: unknown,
	text: string,
	candidates: readonly Pick<DeclaredAgent, 'name'>[]
): Effect.Effect<RoutedReport, RouterAnswerError> {
	const answer =
		toolArguments === undefined
			? decodeTextAnswer(text)
			: decodeToolArguments(toolArguments)
	return answer.pipe(
		Effect.map(({ add, risk }) => ({
			status: 'ok',
			risk,
			added: getValidAdditions(add, candidates),
		}))
	)
}
