import {
	getHigherLevel,
	parseRiskDescription,
	RISK_STATUS_CONTEXT,
	type StatusLevel,
} from '@mng-review/domain'
import { Predicate } from 'effect'
import {
	type BotIdentity,
	GITHUB_ACTIONS_IDENTITY,
	isIdentity,
	isOwnedCreator,
} from '../../../platform/bot-identity.helper'
import type { PullRequestReview } from '../../../platform/github-api.schema'
import type {
	RiskCommitStatus,
	TimelineItem,
} from '../../../platform/github-risk.schema'
import { parseSummaryMarker } from '../../publish/domain/publish-marker.parser'
import { bringsHead } from './risk-label.helper'
import { RATED_STATES, TIMELINE_TYPES } from './risk.constants'
import type { AppRiskStatus } from './risk.types'

/** True when the app wrote it and nobody else edited it; a comment nobody edited has no editor. */
export function isAppAuthored(
	comment: Pick<PullRequestReview, 'author' | 'editor'>,
	app: BotIdentity
): boolean {
	return (
		isIdentity(comment.author, app) &&
		(comment.editor === null || isIdentity(comment.editor, app))
	)
}

/**
 * The commits an item brings: a commit, or both sides of a force push. `undefined` when an item
 * that brings commits lacks one, such as a head GitHub no longer resolves.
 */
function getItemHeads(item: TimelineItem): string[] | undefined {
	if (item.__typename === TIMELINE_TYPES.COMMIT)
		return item.commit ? [item.commit.oid] : undefined
	if (item.__typename !== TIMELINE_TYPES.FORCE_PUSH) return []
	if (!(item.beforeCommit && item.afterCommit)) return undefined
	return [item.beforeCommit.oid, item.afterCommit.oid]
}

/**
 * Every head the pull request ever had as its timeline lists it, the current head included, in
 * timeline order without repeats. `undefined` when a commit or force push lacks its commit: that
 * head may hold the only High, so the held read fails instead of skipping it.
 */
export function getTimelineHeads(
	items: readonly TimelineItem[],
	head: string
): string[] | undefined {
	const heads = items.map(getItemHeads)
	if (!heads.every(Predicate.isNotUndefined)) return undefined
	return [...new Set([...heads.flat(), head])]
}

/** The bots whose statuses a reader takes: the token's app and the apps that count with it. */
export interface StatusOwners {
	readonly current: BotIdentity
	readonly identities: readonly BotIdentity[]
}

/**
 * The owners the held level and the app history read: the token's app and the previous apps in
 * `identity.previous`, never the job token, which a pull request's own workflow can write as.
 */
export function getHeldOwners(owned: StatusOwners): StatusOwners {
	return {
		current: owned.current,
		identities: owned.identities.filter(
			identity => identity.login !== GITHUB_ACTIONS_IDENTITY.login
		),
	}
}

/**
 * The `MNG Review risk` statuses of `owners` on one commit for `pullNumber`, newest first, each
 * marked when the token's own app wrote it: in the exact description form, for this number.
 * Statuses for another pull request on the same commit, another creator or any other text are
 * left out.
 */
export function toAppRiskStatuses(
	sha: string,
	statuses: readonly RiskCommitStatus[],
	owners: StatusOwners,
	pullNumber: number
): AppRiskStatus[] {
	return statuses
		.filter(
			status =>
				status.context === RISK_STATUS_CONTEXT &&
				isOwnedCreator(status.creator, owners.identities)
		)
		.flatMap(status => {
			const description = parseRiskDescription(status.description ?? '')
			if (description?.pr !== pullNumber) return []
			const current = isOwnedCreator(status.creator, [owners.current])
			return [{ id: status.id, sha, state: status.state, description, current }]
		})
		.toSorted((first, second) => second.id - first.id)
}

/** The highest level on any of the statuses, `error` included; `none` when there are none. */
export function getStatusesHighest(
	statuses: readonly AppRiskStatus[]
): StatusLevel {
	return statuses.reduce<StatusLevel>(
		(level, status) => getHigherLevel(level, status.description.level),
		'none'
	)
}

/**
 * The newest of the token's own app's statuses on `sha` for the pull request; the API's ids only
 * grow. A previous app's status never decides a nonce.
 */
export function getNewestStatus(
	statuses: readonly AppRiskStatus[],
	sha: string
): AppRiskStatus | undefined {
	return statuses
		.filter(status => status.current && status.sha === sha)
		.reduce<AppRiskStatus | undefined>(
			(newest, status) =>
				newest === undefined || status.id > newest.id ? status : newest,
			undefined
		)
}

/** True for a real rating: `success` or `failure`. An `error` is not history. */
export function isRatedStatus(status: Pick<AppRiskStatus, 'state'>): boolean {
	return RATED_STATES.some(state => state === status.state)
}

/**
 * True when the pull request has app history: a rated status for its number, or a review one of
 * `apps` wrote whose summary marker says it carries a rating block. A review without one does not
 * count.
 */
export function hasAppHistory(
	statuses: readonly AppRiskStatus[],
	reviews: readonly PullRequestReview[],
	apps: readonly BotIdentity[]
): boolean {
	return (
		statuses.some(isRatedStatus) ||
		reviews.some(
			review =>
				apps.some(app => isAppAuthored(review, app)) &&
				parseSummaryMarker(review.body)?.risk !== undefined
		)
	)
}

/**
 * Ids of the conversation comments posted since `head` arrived, in timeline order: after the last
 * commit or force push that brought it. A head the timeline does not show leaves every comment.
 */
export function getCommentsSinceHead(
	items: readonly TimelineItem[],
	head: string
): Set<number> {
	const from = items.findLastIndex(item => bringsHead(item, head))
	return new Set(
		items
			.slice(from + 1)
			.flatMap(item =>
				item.__typename === TIMELINE_TYPES.COMMENT && item.databaseId
					? [item.databaseId]
					: []
			)
	)
}
