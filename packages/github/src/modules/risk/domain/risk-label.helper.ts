import {
	getHigherLevel,
	RATED_LEVELS,
	type RiskConfig,
	type RiskLevel,
} from '@mng-review/domain'
import {
	type BotIdentity,
	isOwnedBot,
} from '../../../platform/bot-identity.helper'
import type { TimelineItem } from '../../../platform/github-risk.schema'
import { TIMELINE_TYPES } from './risk.constants'

/** The label writes that leave exactly one configured risk label, or none on a revocation. */
export interface LabelPlan {
	readonly add?: string
	readonly remove: readonly string[]
}

/**
 * What the label plan reads: the configured names, the labels on the pull request and who set
 * them.
 */
export interface LabelState {
	readonly labels: RiskConfig['labels']
	/** The pull request's labels now. */
	readonly current: readonly string[]
	/**
	 * Lower-cased risk labels a person set on the current head, after it arrived and not by the
	 * bot.
	 */
	readonly personSet: ReadonlySet<string>
}

/** True when the item brought `head`: a commit with its oid, or a force push onto it. */
function bringsHead(item: TimelineItem, head: string): boolean {
	if (item.__typename === TIMELINE_TYPES.COMMIT)
		return item.commit?.oid === head
	return (
		item.__typename === TIMELINE_TYPES.FORCE_PUSH &&
		item.afterCommit?.oid === head
	)
}

/**
 * Lower-cased labels whose latest change since `head` arrived is a person adding them: not an
 * owned bot and not the job token's bot. `undefined` when the timeline does not show the head, so
 * who set a label is unknown and the caller changes no label.
 */
export function getPersonLabels(
	items: readonly TimelineItem[],
	head: string,
	owned: readonly BotIdentity[]
): Set<string> | undefined {
	const from = items.findLastIndex(item => bringsHead(item, head))
	if (from === -1) return undefined
	const latest = new Map<string, boolean>()
	for (const item of items.slice(from + 1)) {
		const name = item.label?.name.toLowerCase()
		if (name === undefined) continue
		const added = item.__typename === TIMELINE_TYPES.LABELED
		latest.set(name, added && !isOwnedBot(item.actor ?? null, owned))
	}
	return new Set(
		[...latest].filter(([, person]) => person).map(([name]) => name)
	)
}

/** The label events of a timeline as text: added or removed, by whom, which label. */
function toLabelEvents(items: readonly TimelineItem[]): string[] {
	return items.flatMap(item =>
		item.label
			? [`${item.__typename}:${item.actor?.login ?? ''}:${item.label.name}`]
			: []
	)
}

/** True when two timeline reads list the same label events, so no label changed between them. */
export function hasSameLabelEvents(
	first: readonly TimelineItem[],
	second: readonly TimelineItem[]
): boolean {
	const before = toLabelEvents(first)
	const after = toLabelEvents(second)
	return (
		before.length === after.length &&
		before.every((event, index) => event === after[index])
	)
}

/** The configured level of a label name, compared without case. */
function getLabelLevel(
	labels: RiskConfig['labels'],
	name: string
): RiskLevel | undefined {
	return RATED_LEVELS.find(
		level => labels[level].toLowerCase() === name.toLowerCase()
	)
}

/**
 * The writes that set `level`'s label, or with no level remove the bot's: a risk label a person
 * set higher on the current head stays and no lower one is added; every other risk label goes.
 * Labels outside `risk.labels` are never touched. A kept higher label does not raise the status or
 * stop a grant; the merge script refuses a pull request whose risk label is above its status level.
 */
export function planRiskLabels(
	state: LabelState,
	level: RiskLevel | undefined
): LabelPlan {
	const risk = state.current.flatMap(name => {
		const found = getLabelLevel(state.labels, name)
		return found === undefined ? [] : [{ name, level: found }]
	})
	const person = risk.filter(entry =>
		state.personSet.has(entry.name.toLowerCase())
	)
	if (level === undefined)
		return {
			remove: risk
				.filter(entry => !person.includes(entry))
				.map(entry => entry.name),
		}
	const higher = person
		.filter(entry => getHigherLevel(entry.level, level) !== level)
		.toSorted(
			(first, second) =>
				RATED_LEVELS.indexOf(second.level) - RATED_LEVELS.indexOf(first.level)
		)
		.at(0)
	const keep = higher?.level ?? level
	const remove = risk
		.filter(entry => entry.level !== keep)
		.map(entry => entry.name)
	const has = risk.some(entry => entry.level === keep)
	return has || higher ? { remove } : { add: state.labels[level], remove }
}
