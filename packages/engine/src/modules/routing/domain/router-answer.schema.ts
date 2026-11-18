import { RISK_LEVELS } from '@mng-review/domain'
import { Effect, Schema } from 'effect'

/** One agent the router adds, with the reason that names the triggering file or code. */
export const routerAdditionSchema = Schema.Struct({
	agent: Schema.String,
	reason: Schema.String,
})
export type RouterAdditionAnswer = typeof routerAdditionSchema.Type

/** The router's answer: the `route` tool's arguments or the same JSON as text. `add` may be left out. */
export const routerAnswerSchema = Schema.Struct({
	add: Schema.Array(routerAdditionSchema).pipe(
		Schema.withDecodingDefault(Effect.succeed([]))
	),
	risk: Schema.Literals(RISK_LEVELS),
})
export type RouterAnswer = typeof routerAnswerSchema.Type
