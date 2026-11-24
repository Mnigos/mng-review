import {
	getHigherLevel,
	type RiskLevel,
	type StatusLevel,
} from '@mng-review/domain'
import { Predicate } from 'effect'
import {
	type BotIdentity,
	isIdentity,
} from '../../../platform/bot-identity.helper'
import type { PullRequestComment } from '../../../platform/github-api.schema'
import type {
	CommentEdit,
	CommentEdits,
} from '../../../platform/github-risk.schema'
import {
	hasRiskMarker,
	parseRiskMarker,
	parseRiskMarkerForms,
} from '../../publish/domain/publish-marker.parser'
import { MARKER_VERSION } from '../../publish/domain/publish.constants'
import {
	MARKER_NULL_STOP,
	MARKER_PARTIAL_STOP,
	MARKER_RACE_STOP,
	MARKER_UNSEEN_STOP,
} from './grant-stop.constants'
import { isAppAuthored, isRatedStatus } from './risk-history.helper'
import type { RatedHead, RiskMarker } from './risk-marker.schema'
import { MAX_RATED_HEADS } from './risk.constants'
import type { AppRiskStatus, GrantStop, MarkerRead } from './risk.types'

/** A marker with no rated heads, as step 1 creates it. */
export const EMPTY_RISK_MARKER = {
	v: MARKER_VERSION,
	highest: 'none',
	heads: [],
} as const satisfies RiskMarker

/**
 * The highest level edited text names in any valid risk marker form anywhere in it, its highest or
 * a head's; `none` when it names none. A person can leave several forms, so none is preferred.
 */
function getNamedLevel(body: string): StatusLevel {
	return parseRiskMarkerForms(body)
		.flatMap(marker => [
			marker.highest,
			...marker.heads.map(head => head.level),
		])
		.reduce<StatusLevel>(getHigherLevel, 'none')
}

/**
 * The app's risk comment among the pull request's comments: the oldest comment the app wrote that
 * ends with a risk marker. It is trusted only while the app is its last editor and the marker
 * decodes; a comment someone else edited counts as edited, and its text can only raise.
 */
export function toMarkerRead(
	comments: readonly PullRequestComment[],
	app: BotIdentity
): MarkerRead {
	const comment = comments.find(
		entry =>
			entry.databaseId !== null &&
			isIdentity(entry.author, app) &&
			hasRiskMarker(entry.body)
	)
	if (!comment || comment.databaseId === null) return { status: 'none' }
	const marker = parseRiskMarker(comment.body)
	if (marker && isAppAuthored(comment, app))
		return {
			status: 'trusted',
			id: comment.databaseId,
			nodeId: comment.id,
			body: comment.body,
			marker,
		}
	return {
		status: 'edited',
		id: comment.databaseId,
		nodeId: comment.id,
		body: comment.body,
		named: getNamedLevel(comment.body),
	}
}

/** What a head must share with a rated head to reuse its level. */
export type ReuseKey = Pick<RatedHead, 'tree' | 'base' | 'rules'>

/** The level a rated head with the same tree, base and rules got, the newest such entry's. */
export function getReusedLevel(
	marker: RiskMarker,
	key: ReuseKey
): RiskLevel | undefined {
	return marker.heads.findLast(
		entry =>
			entry.tree === key.tree &&
			entry.base === key.base &&
			entry.rules === key.rules
	)?.level
}

/**
 * The marker after a rating: the head added (replacing an earlier entry for the same head), the
 * oldest dropped past `MAX_RATED_HEADS`, and the highest raised. Nothing is lowered.
 */
export function toNextRiskMarker(
	marker: RiskMarker,
	entry: RatedHead
): RiskMarker {
	return {
		v: MARKER_VERSION,
		highest: getHigherLevel(marker.highest, entry.level),
		heads: [
			...marker.heads.filter(head => head.head !== entry.head),
			entry,
		].slice(-MAX_RATED_HEADS),
	}
}

/** The marker with its highest raised to `level`; the heads stay. */
export function toRaisedRiskMarker(
	marker: RiskMarker,
	level: StatusLevel
): RiskMarker {
	return { ...marker, highest: getHigherLevel(marker.highest, level) }
}

/**
 * The marker rebuilt from the app's own statuses after someone else edited it: the highest is the
 * highest level among them, `error` included, raised by what the edited text names; the rated
 * heads come from the grants, newest per head and in the order of those grants, with the tree git
 * gave. A head whose tree is
 * unknown is left out, which only costs a rerun.
 */
export function toRebuiltRiskMarker(
	statuses: readonly AppRiskStatus[],
	trees: ReadonlyMap<string, string>,
	named: StatusLevel
): RiskMarker {
	const highest = statuses.reduce<StatusLevel>(
		(level, status) => getHigherLevel(level, status.description.level),
		named
	)
	const grants = statuses
		.filter(isRatedStatus)
		.toSorted((first, second) => first.id - second.id)
	const heads = grants.flatMap((status): RatedHead[] => {
		const tree = trees.get(status.sha)
		const { level, base, rules } = status.description
		if (tree === undefined || level === 'none') return []
		return [{ head: status.sha, tree, base, rules, level }]
	})
	// Each head at its latest grant's place, so the cap drops the heads granted longest ago.
	const latest = heads.filter(
		(entry, index) =>
			heads.findLastIndex(other => other.head === entry.head) === index
	)
	return {
		v: MARKER_VERSION,
		highest,
		heads: latest.slice(-MAX_RATED_HEADS),
	}
}

/** The edits `after` lists that `before` did not, matched by GitHub's edit id. */
function getEditsSince(
	before: Pick<CommentEdits, 'edits'>,
	after: Pick<CommentEdits, 'edits'>
): CommentEdit[] {
	const seen = new Set(
		before.edits.filter(Predicate.isNotNull).map(edit => edit.id)
	)
	return after.edits
		.filter(Predicate.isNotNull)
		.filter(edit => !seen.has(edit.id))
}

/** How many edits the history lists as null nodes. */
function countNullEdits(edits: Pick<CommentEdits, 'edits'>): number {
	return edits.edits.filter(Predicate.isNull).length
}

/**
 * True when `after` may hide an edit since `before`: GitHub counts more new edits than it lists,
 * or it no longer lists the newest edit `before` did. GitHub keeps the original text and the 99
 * newest edits, so the original stays in both reads while edits in between drop out; only while
 * `after` still lists `before`'s newest edit is every edit since then listed.
 */
function hidesEdits(
	before: Pick<CommentEdits, 'total' | 'edits'>,
	after: Pick<CommentEdits, 'total' | 'edits'>,
	since: readonly CommentEdit[]
): boolean {
	const newest = before.edits
		.filter(Predicate.isNotNull)
		.reduce<CommentEdit | undefined>(
			(latest, edit) =>
				latest === undefined || edit.editedAt > latest.editedAt ? edit : latest,
			undefined
		)
	const listed = new Set(
		after.edits.filter(Predicate.isNotNull).map(edit => edit.id)
	)
	return (
		after.total - before.total > since.length ||
		(newest !== undefined && !listed.has(newest.id))
	)
}

/**
 * Why the edits a risk comment got while a run updated it stop that run's grant, or `undefined`
 * when only `app` edited it. `before` is read before the update and `after` after it, each the
 * whole history GitHub keeps; the edits since `before` are the ones `after` lists by an id `before`
 * did not, this run's own update included, so neither GitHub's order nor its 100-edit retention
 * matters. No new edit (`MARKER_UNSEEN_STOP`, which the caller reads again for), more null nodes
 * than `before` listed, or more new edits counted than listed, stop the grant too. A null node
 * both reads list was counted as High by the run's start already. A person's edit there was
 * overwritten, and the next full run reads its level back from the history (`getEditedLevel`).
 */
export function getMarkerEditStop(
	before: Pick<CommentEdits, 'total' | 'edits'>,
	after: Pick<CommentEdits, 'total' | 'edits'>,
	app: BotIdentity
): GrantStop | undefined {
	const since = getEditsSince(before, after)
	if (since.length === 0) return MARKER_UNSEEN_STOP
	if (countNullEdits(after) > countNullEdits(before)) return MARKER_NULL_STOP
	if (hidesEdits(before, after, since)) return MARKER_PARTIAL_STOP
	if (since.some(edit => !isIdentity(edit.editor, app))) return MARKER_RACE_STOP
	return undefined
}

/**
 * The highest level any edit of the risk comment by someone other than `app` names, across the
 * whole history GitHub keeps: GitHub's `diff` of an edit is the whole text it left, so an edit an
 * app write later overwrote still shows there. A person's text GitHub does not give, and an edit
 * GitHub lists as a null node, count as High, the highest a status carries; `none` when only `app`
 * edited. GitHub keeps the original and the 99 newest edits; an edit that drops out was read by
 * the full runs while it was listed. A null original never drops out, so it holds High for good.
 */
export function getEditedLevel(
	edits: Pick<CommentEdits, 'edits'>,
	app: BotIdentity
): StatusLevel {
	return edits.edits
		.filter(edit => edit === null || !isIdentity(edit.editor, app))
		.reduce<StatusLevel>(
			(level, edit) =>
				edit === null || edit.diff === null
					? 'high'
					: getHigherLevel(level, getNamedLevel(edit.diff)),
			'none'
		)
}

/**
 * Why a grant at `level` must stop because the history read before the finish path's update shows
 * a higher level a person's edit named (`getEditedLevel`), or `undefined` when none does. The run's
 * start read that history too, but GitHub can list an edit there only later.
 */
export function getEditedLevelStop(
	before: Pick<CommentEdits, 'edits'>,
	level: RiskLevel,
	app: BotIdentity
): GrantStop | undefined {
	const edited = getEditedLevel(before, app)
	if (getHigherLevel(edited, level) === level) return undefined
	return {
		reason: 'marker-edited',
		detail: `an edit in the risk comment's history names ${edited}, above ${level}`,
	}
}
