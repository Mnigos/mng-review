import { commitShaSchema, countSchema } from '@mng-review/domain'
import { botThreadSchema } from '@mng-review/github'
import { Schema } from 'effect'

/** What the engine is told about the pull request, as the prepare step parsed it from the event. */
const pullRequestInfoSchema = Schema.Struct({
	author: Schema.optionalKey(Schema.String),
	labels: Schema.Array(Schema.String),
	target: Schema.optionalKey(Schema.String),
	title: Schema.optionalKey(Schema.String),
	body: Schema.optionalKey(Schema.String),
	draft: Schema.Boolean,
	fork: Schema.Boolean,
	trigger: Schema.Literals(['auto', 'manual']),
})

/** The pull request the run reviews: the event's action, its number, both commits and its metadata. */
export const preparedEventSchema = Schema.Struct({
	action: Schema.optionalKey(Schema.String),
	number: Schema.Int,
	baseSha: commitShaSchema,
	headSha: commitShaSchema,
	pr: pullRequestInfoSchema,
})

const readySchema = Schema.Struct({
	status: Schema.Literal('ready'),
	event: preparedEventSchema,
	prior: Schema.optionalKey(
		Schema.Struct({
			runs: countSchema,
			head: Schema.optionalKey(Schema.String),
		})
	),
	threads: Schema.Array(botThreadSchema),
})

const skippedSchema = Schema.Struct({
	status: Schema.Literal('skipped'),
	reason: Schema.String,
	event: Schema.optionalKey(preparedEventSchema),
})

const invalidConfigSchema = Schema.Struct({
	status: Schema.Literal('invalid-config'),
	source: Schema.String,
	reason: Schema.String,
	event: Schema.optionalKey(preparedEventSchema),
})

const failedSchema = Schema.Struct({
	status: Schema.Literal('failed'),
	reason: Schema.String,
	event: preparedEventSchema,
})

/**
 * The prepared file the prepare step writes into `RUNNER_TEMP` for the review step of the same job.
 * It is never uploaded, and it is still decoded, since another process wrote it.
 */
export const preparedRunSchema = Schema.Union([
	readySchema,
	skippedSchema,
	invalidConfigSchema,
	failedSchema,
])
export type PreparedRunFile = typeof preparedRunSchema.Type
