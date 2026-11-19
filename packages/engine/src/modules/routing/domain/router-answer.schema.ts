import { RISK_CATEGORIES } from '@mng-review/domain'
import { Effect, Schema } from 'effect'

/** One agent the router adds, with the reason that names the triggering file or code. */
export const routerAdditionSchema = Schema.Struct({
	agent: Schema.String,
	reason: Schema.String,
})
export type RouterAdditionAnswer = typeof routerAdditionSchema.Type

/** One risk signal: its category, the changed file and the code in it that does that. */
export const riskSignalSchema = Schema.Struct({
	category: Schema.Literals(RISK_CATEGORIES),
	path: Schema.String,
	reason: Schema.String,
})

/**
 * The router's answer: the `route` tool's arguments or the same JSON as text. `add` and `signals`
 * may be left out; `trivial` defaults to false.
 */
export const routerAnswerSchema = Schema.Struct({
	add: Schema.Array(routerAdditionSchema).pipe(
		Schema.withDecodingDefault(Effect.succeed([]))
	),
	signals: Schema.Array(riskSignalSchema).pipe(
		Schema.withDecodingDefault(Effect.succeed([]))
	),
	trivial: Schema.Boolean.pipe(
		Schema.withDecodingDefault(Effect.succeed(false))
	),
})
export type RouterAnswer = typeof routerAnswerSchema.Type
