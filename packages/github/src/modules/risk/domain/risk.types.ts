import type {
	FloorHit,
	FloorReport,
	RiskDescription,
	RiskLevel,
	StatusLevel,
	UnratedReason,
} from '@mng-review/domain'
import type { RiskRating } from '@mng-review/engine'
import type {
	DecidedThreadReply,
	ThreadReplyDecision,
} from '../../publish/domain/thread-reply.schema'
import type { RiskMarker } from './risk-marker.schema'

/** Why the checks before the grant, or the read after it, stopped the grant. */
export interface GrantStop {
	readonly reason: UnratedReason
	readonly detail: string
}

/** One app `MNG Review risk` status for the pull request being rated, on one of its heads. */
export interface AppRiskStatus {
	readonly id: number
	readonly sha: string
	readonly state: string
	readonly description: RiskDescription
	/**
	 * Written by the token's own app. A previous app's status counts for the held level and the
	 * history, never for a nonce.
	 */
	readonly current: boolean
}

/**
 * The app's risk comment as publish read it: none, trusted (the app wrote it and nobody else
 * edited it), or edited by someone else, with the level the edited text names when it decodes.
 */
export type MarkerRead =
	| { readonly status: 'none' }
	| {
			readonly status: 'trusted'
			readonly id: number
			/** The GraphQL node id the edit history is read by; unset for a comment step 1 created. */
			readonly nodeId?: string
			readonly body: string
			readonly marker: RiskMarker
	  }
	| {
			readonly status: 'edited'
			readonly id: number
			/** The GraphQL node id the rebuild reads the edit history by. */
			readonly nodeId: string
			/** The edited text, so a rewrite can check it still replaces the edit it accounted for. */
			readonly body: string
			/** The highest level the edited text names; it can only raise. */
			readonly named: StatusLevel
	  }
	| { readonly status: 'failed' }

/** What the held read gives every run before any model call or write. */
export interface RiskHistory {
	/** Every head the timeline lists, the current one included. */
	readonly heads: readonly string[]
	/** The app's statuses for this pull request's number on every head, newest first per head. */
	readonly statuses: readonly AppRiskStatus[]
	readonly held: StatusLevel
}

/** What decides a full run's level, every part read by publish itself but the engine's rating. */
export interface FullRatingFacts {
	readonly rating: RiskRating | undefined
	/** The floors from publish's own floor diff; `undefined` when git could not read it. */
	readonly floors: FloorReport | undefined
	readonly routerRisky: boolean
	/** Severities of the confirmed bugs this run kept and of the open confirmed bug threads. */
	readonly confirmedBugs: readonly string[]
	readonly threadsRead: boolean
	readonly marker: MarkerRead
	/** The pull request had a real rating: a rating review or a `success` or `failure` status. */
	readonly history: boolean
	/** The stored level of a rated head with the same tree and base, when the marker has one. */
	readonly reused: RiskLevel | undefined
	readonly held: StatusLevel
}

/** What a thread run decides on: its thread read, the marker and the history. */
export type ThreadRatingFacts = Pick<
	FullRatingFacts,
	'confirmedBugs' | 'threadsRead' | 'marker' | 'history' | 'held'
>

/**
 * A run's decision before step 1: rated at a level, not rated with a reason, or (a thread run that
 * found nothing to raise) nothing to write. `stepOne` is the level step 1's `error` carries.
 */
export type RatingDecision =
	| {
			readonly status: 'rated'
			readonly level: RiskLevel
			readonly floor: boolean
			readonly stepOne: StatusLevel
	  }
	| {
			readonly status: 'unrated'
			readonly reason: UnratedReason
			readonly detail: string
			readonly floor: boolean
			readonly stepOne: StatusLevel
	  }
	| { readonly status: 'none' }

/** A decision that writes step 1: rated or not rated. */
export type WritingDecision = Exclude<
	RatingDecision,
	{ readonly status: 'none' }
>

/**
 * What the rating block of a review shows: a level with its reasons and floors, or why not
 * rated.
 */
export type RatingBlock =
	| {
			readonly status: 'rated'
			readonly level: RiskLevel
			readonly floors: readonly FloorHit[]
			/** The rater's reasons, model text that is escaped before it is shown. */
			readonly reasons: readonly string[]
			/** Set when the level came from a rated head with the same tree and base. */
			readonly reused: boolean
	  }
	| {
			readonly status: 'unrated'
			readonly reason: UnratedReason
			readonly detail: string
			readonly floors: readonly FloorHit[]
	  }

/** A decided reply as the thread raise reads it: its thread and the answer's action. */
export interface AnsweredReply extends Pick<DecidedThreadReply, 'threadId'> {
	readonly decision: Pick<ThreadReplyDecision, 'action'>
}
