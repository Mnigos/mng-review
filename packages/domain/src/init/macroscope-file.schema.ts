import { Schema } from 'effect'
import { nameListSchema } from '../config/review-config.schema'

const optionalListSchema = Schema.optionalKey(nameListSchema)

/** Front matter keys of `.macroscope/correctness/correctness.md` that `init` imports. */
export const macroscopeCorrectnessSchema = Schema.Struct({
	exclude: optionalListSchema,
	requires: optionalListSchema,
})
export type MacroscopeCorrectness = typeof macroscopeCorrectnessSchema.Type

/** Front matter keys of `.macroscope/approvability.md` that `init` imports. */
export const macroscopeApprovabilitySchema = Schema.Struct({
	neverApprove: optionalListSchema,
	alwaysApprove: optionalListSchema,
})
export type MacroscopeApprovability = typeof macroscopeApprovabilitySchema.Type

/** Front matter keys of `.macroscope/check-run-agents/*.md` that `init` imports. */
export const macroscopeAgentSchema = Schema.Struct({
	title: Schema.optionalKey(Schema.Trim.check(Schema.isNonEmpty())),
	include: optionalListSchema,
	exclude: optionalListSchema,
	labels: optionalListSchema,
	authors: optionalListSchema,
	targets: optionalListSchema,
	requires: optionalListSchema,
	input: Schema.optionalKey(Schema.String),
})
export type MacroscopeAgent = typeof macroscopeAgentSchema.Type
