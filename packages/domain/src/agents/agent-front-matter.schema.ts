import { Effect, Schema } from 'effect'
import {
	commentsOverrideSchema,
	effortSchema,
	nameListSchema,
	positiveIntSchema,
} from '../config/review-config.schema'
import {
	AGENT_INPUTS,
	AGENT_KINDS,
	DEFAULT_AGENT_INPUT,
	DEFAULT_MAX_FINDINGS,
} from './agent.constants'

/** A name list that defaults to empty when the key is missing. */
const optionalNameListSchema = nameListSchema.pipe(
	Schema.withDecodingDefault(Effect.succeed([]))
)

export const agentKindSchema = Schema.Literals(AGENT_KINDS)
export type AgentKind = typeof agentKindSchema.Type
export const agentInputSchema = Schema.Literals(AGENT_INPUTS)
export type AgentInput = typeof agentInputSchema.Type

/** Selection rules; every non-empty list must match. */
export const agentWhenSchema = Schema.Struct({
	paths: optionalNameListSchema,
	exclude: optionalNameListSchema,
	labels: optionalNameListSchema,
	authors: optionalNameListSchema,
	targets: optionalNameListSchema,
	/** The sentence the router reads to decide whether to add an agent no path selected. */
	triage: Schema.optionalKey(Schema.Trim.check(Schema.isNonEmpty())),
})
export type AgentWhen = typeof agentWhenSchema.Type

/** YAML front matter of `.mng/agents/<name>.md`; it overrides `review.yml` for that agent. */
export const agentFrontMatterSchema = Schema.Struct({
	title: Schema.optionalKey(Schema.NonEmptyString),
	kind: agentKindSchema,
	when: agentWhenSchema.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
	model: Schema.optionalKey(Schema.NonEmptyString),
	effort: Schema.optionalKey(effortSchema),
	input: agentInputSchema.pipe(
		Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENT_INPUT))
	),
	/** Check names that must pass before the agent runs. */
	needs: optionalNameListSchema,
	max_findings: positiveIntSchema.pipe(
		Schema.withDecodingDefault(Effect.succeed(DEFAULT_MAX_FINDINGS))
	),
	comments: Schema.optionalKey(commentsOverrideSchema),
})
export type AgentFrontMatter = typeof agentFrontMatterSchema.Type
