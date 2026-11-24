import { Schema } from 'effect'
import { AGENT_NAME_PATTERN } from '../agents/agent.constants'
import {
	ANSWER_DIGEST_PATTERN,
	ANSWER_KINDS,
	EDIT_TIME_PATTERN,
} from './risk.constants'

/** A GitHub database id: a run id or a comment id. */
const databaseIdSchema = Schema.Int.check(Schema.isGreaterThan(0))
export const answerKindSchema = Schema.Literals(ANSWER_KINDS)
export type AnswerKind = typeof answerKindSchema.Type

/** One comment an answer names, at the version the run read. */
export const answeredCommentSchema = Schema.Struct({
	id: databaseIdSchema,
	/** `lastEditedAt`, or the creation time of an unedited comment, as GraphQL gives it. */
	at: Schema.String.check(Schema.isPattern(EDIT_TIME_PATTERN)),
	/** The first 16 hex characters of the body digest (`toAnswerDigest`). */
	digest: Schema.String.check(Schema.isPattern(ANSWER_DIGEST_PATTERN)),
})
export type AnsweredComment = typeof answeredCommentSchema.Type

/** The two fields of an entry the agent rule reads. */
interface AgentField {
	readonly kind: AnswerKind
	readonly agent?: string
}

/** `agent` names the agent of a `run <agent>` answer and appears on no other kind. */
const hasAgentOnRunOnly = Schema.makeFilter(
	(entry: AgentField) =>
		(entry.kind === 'run') === (entry.agent !== undefined) ||
		'agent is set on a run answer and only there'
)

/**
 * One entry of an app answer's marker: the run that answered, what it did and the comments it
 * handled. A comment counts as answered only by an entry naming its id, its current edit time and
 * the digest of its current body.
 */
export const answerEntrySchema = Schema.Struct({
	run: databaseIdSchema,
	kind: answerKindSchema,
	agent: Schema.optionalKey(
		Schema.String.check(Schema.isPattern(AGENT_NAME_PATTERN))
	),
	ids: Schema.NonEmptyArray(answeredCommentSchema),
}).check(hasAgentOnRunOnly)
export type AnswerEntry = typeof answerEntrySchema.Type
