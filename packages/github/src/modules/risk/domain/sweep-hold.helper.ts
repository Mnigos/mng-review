import { Predicate } from 'effect'
import type { BotIdentity } from '../../../platform/bot-identity.helper'
import type { ThreadComment } from '../../../platform/github-api.schema'
import type {
	TimelineItem,
	WorkflowRun,
} from '../../../platform/github-risk.schema'
import { isBotComment } from '../../publish/domain/bot-thread.helper'
import type { CommentVersion } from './answer.helper'
import { type ReplyVersion, toCommentVersion } from './reply-answer.helper'
import { bringsHead } from './risk-label.helper'
import {
	PUSH_EVENT,
	RATING_CONCLUSIONS,
	RATING_EVENTS,
	RISK_RUN_TITLE,
	WORKFLOWS_DIR,
} from './risk.constants'

/**
 * A full rating run as the review hold reads it: when it was created and how its group job ended.
 */
export interface RatingRun {
	readonly createdAt: string
	/** `null` while in flight. */
	readonly conclusion: string | null
}

/**
 * The latest of a comment's or a review's times: created, submitted or published, and last edited.
 * A review drafted before a run and submitted after it counts from its submission.
 */
export function getLatestTime(
	times: readonly (string | null | undefined)[]
): string | undefined {
	return times
		.filter(Predicate.isString)
		.reduce<string | undefined>(
			(latest, time) => (latest === undefined || time > latest ? time : latest),
			undefined
		)
}

/** The earliest of the times, or `undefined` for none. */
export function getEarliestTime(times: readonly string[]): string | undefined {
	return times.reduce<string | undefined>(
		(earliest, time) =>
			earliest === undefined || time < earliest ? time : earliest,
		undefined
	)
}

/** A thread comment's id, body and times, as the review hold reads them. */
type HoldingCandidate = Pick<
	ThreadComment,
	'databaseId' | 'body' | 'createdAt' | 'lastEditedAt'
>

/**
 * The comment that holds a thread for the review hold: the one with the latest time, edits
 * included, so a dispatch is keyed by the comment that made the thread unrated again.
 */
export function getHoldingComment(
	comments: readonly HoldingCandidate[]
): CommentVersion | undefined {
	return comments
		.flatMap(comment => toCommentVersion(comment) ?? [])
		.reduce<CommentVersion | undefined>(
			(latest, version) =>
				latest === undefined || version.at > latest.at ? version : latest,
			undefined
		)
}

/**
 * The unnamed replies of a resolved app thread that still hold: those whose current edit time is at
 * or before the resolving answer, the app's latest answer in the thread. A reply posted or edited
 * after it does not hold, and in a thread a person resolved with no app answer none do.
 */
export function getResolvedHolds(
	comments: readonly ThreadComment[],
	owned: readonly BotIdentity[],
	unnamed: readonly ReplyVersion[]
): ReplyVersion[] {
	const answer = comments.findLast(comment => isBotComment(comment, owned))
	const answeredAt = answer?.createdAt
	if (answeredAt === undefined) return []
	return unnamed.filter(reply => reply.at <= answeredAt)
}

/**
 * True when a full rating run created after `time` concluded with a rating: its group job ended
 * `success` or `failure`. `cancelled` and `skipped` do not count, and a run in flight not yet.
 */
export function isRatedSince(
	time: string,
	runs: readonly RatingRun[]
): boolean {
	return runs.some(
		run =>
			run.createdAt > time &&
			RATING_CONCLUSIONS.some(conclusion => conclusion === run.conclusion)
	)
}

/**
 * Which runs count for a pull request: its number, the review workflow, the default branch and the
 * repository itself.
 */
export interface RunScope {
	readonly pullNumber: number
	/** The review workflow's file name, such as `review.yml`. */
	readonly workflow: string
	readonly defaultBranch: string
	/** The repository's id; a run whose head repository is another one never counts. */
	readonly repositoryId: number
}

/**
 * True when a run's `path` names the workflow file: alone, or with the `@<ref>` GitHub's runs API
 * may add (`.github/workflows/review.yml@main`).
 */
function isWorkflowPath(path: string, workflow: string): boolean {
	const file = `${WORKFLOWS_DIR}${workflow}`
	return path === file || path.startsWith(`${file}@`)
}

/**
 * True for a run of the review workflow from the repository itself that can rate the pull request:
 * a push run (`pull_request_target` naming this number with the default branch as base), or a
 * comment or dispatched run on the default branch named for it. Another workflow, branch or head
 * repository that sets the same name, which any branch or fork can, never counts, so it can add a
 * hold but never lift one.
 */
export function isReviewRun(
	run: Pick<
		WorkflowRun,
		| 'display_title'
		| 'path'
		| 'event'
		| 'head_branch'
		| 'head_repository'
		| 'pull_requests'
	>,
	scope: RunScope
): boolean {
	if (
		!isWorkflowPath(run.path, scope.workflow) ||
		run.head_repository?.id !== scope.repositoryId
	)
		return false
	// A push run names its pull request in `pull_requests`; the others only through their name.
	if (run.event === PUSH_EVENT)
		return (run.pull_requests ?? []).some(
			pr =>
				pr.number === scope.pullNumber && pr.base.ref === scope.defaultBranch
		)
	return (
		run.display_title === `${RISK_RUN_TITLE}${scope.pullNumber}` &&
		RATING_EVENTS.some(event => event === run.event) &&
		run.head_branch === scope.defaultBranch
	)
}

/**
 * When `head` arrived, as a lower bound for the runs the sweep counts for it: the time of the last
 * force push or the committer date of the last commit that brought it, but never later than `now`
 * or the earliest force push that brought it, which GitHub dates. A committer date is set by
 * whoever made the commit, so without a force push to bound it the arrival is `undefined` and the
 * runs list from the pull request's creation; a future date can then never hide earlier dispatches.
 */
export function getHeadArrival(
	items: readonly TimelineItem[],
	head: string,
	now: string
): string | undefined {
	const brought = items.filter(found => bringsHead(found, head))
	const pushed = getEarliestTime(brought.flatMap(item => item.createdAt ?? []))
	if (pushed === undefined) return undefined
	const last = brought.at(-1)
	return getEarliestTime([
		last?.createdAt ?? last?.commit?.committedDate ?? pushed,
		pushed,
		now,
	])
}
