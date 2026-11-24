import { toBotIdentity } from '../../../platform/bot-identity.helper'
import type { CommentEdit } from '../../../platform/github-risk.schema'
import {
	COMMENT_EDITS_BOT,
	getEditedCommentEdits,
} from '../../../shared/mocks/comment-edits.helper'
import {
	RISK_HEAD,
	RISK_BASE,
	RISK_TREE,
	RISK_DESCRIPTION,
	riskStatus,
} from '../../../shared/mocks/github-status-fake.helper'
import {
	appSummary,
	APP_IDENTITY,
} from '../../../shared/mocks/publish-test.helper'
import { toMarkerComment } from '../../publish/presentation/thread-comment.formatter'
import {
	MARKER_PARTIAL_STOP,
	MARKER_RACE_STOP,
	MARKER_UNSEEN_STOP,
} from './grant-stop.constants'
import { toAppRiskStatuses } from './risk-history.helper'
import {
	EMPTY_RISK_MARKER,
	getMarkerEditStop,
	getOverwrittenLevel,
	toMarkerRead,
	getReusedLevel,
	toNextRiskMarker,
	toRebuiltRiskMarker,
} from './risk-marker.helper'
import { MAX_RATED_HEADS } from './risk.constants'

const ENTRY = {
	head: RISK_HEAD,
	tree: RISK_TREE,
	base: RISK_BASE,
	rules: RISK_DESCRIPTION.rules,
	level: 'medium',
} as const
const KEY = {
	tree: RISK_TREE,
	base: RISK_BASE,
	rules: RISK_DESCRIPTION.rules,
} as const
const MARKER = {
	...EMPTY_RISK_MARKER,
	highest: 'medium',
	heads: [ENTRY],
} as const

const APP_ONLY = { current: APP_IDENTITY, identities: [APP_IDENTITY] } as const

/** An edit time `minute` minutes into the fixture day, in GitHub's format. */
function at(minute: number) {
	return `2026-01-01T00:${String(minute).padStart(2, '0')}:00Z`
}

/** An edit by the app at `minute`, with an id that stays the same across reads. */
function appEdit(minute: number): CommentEdit {
	return {
		id: `app-${minute}`,
		editor: { __typename: 'Bot', login: APP_IDENTITY.login },
		editedAt: at(minute),
		diff: 'marker',
	}
}

/** GitHub's documented limit on the edits it keeps for one comment. */
const EDIT_RETENTION = 100

/** A full retained history of older app edits, newest first. */
function retained() {
	return Array.from({ length: EDIT_RETENTION }, (_, index) => ({
		...appEdit(0),
		id: `app-old-${EDIT_RETENTION - index}`,
	}))
}

/** `edits`, given newest first, in the order GitHub lists them. */
function listed(
	order: 'newest first' | 'oldest first',
	edits: readonly CommentEdit[]
) {
	return order === 'newest first' ? edits : edits.toReversed()
}

/** A complete edit history: every edit GitHub counts is listed. */
function history(edits: readonly (CommentEdit | null)[]) {
	return { total: edits.length, edits }
}

/** An edit by a person whose login matches the app's at `minute`, leaving `text`. */
function personEdit(minute: number, text = 'marker'): CommentEdit {
	return {
		id: `person-${minute}`,
		editor: { __typename: 'User', login: APP_IDENTITY.login },
		editedAt: at(minute),
		diff: text,
	}
}

describe('risk marker', () => {
	for (const editor of [null, appSummary().author])
		test(`trusts an app marker with editor ${editor?.login ?? 'missing'}`, () => {
			expect(
				toMarkerRead(
					[
						appSummary(undefined, {
							body: toMarkerComment('risk', MARKER),
							editor,
						}),
					],
					APP_IDENTITY
				)
			).toMatchObject({
				status: 'trusted',
				nodeId: appSummary().id,
				marker: MARKER,
			})
		})
	test('a person edit can only raise and its rated entries are untrusted', () => {
		expect(
			toMarkerRead(
				[
					appSummary(undefined, {
						body: toMarkerComment('risk', {
							...MARKER,
							heads: [{ ...ENTRY, level: 'high' }],
						}),
						editor: { __typename: 'User', login: 'writer' },
					}),
				],
				APP_IDENTITY
			)
		).toMatchObject({
			status: 'edited',
			nodeId: appSummary().id,
			named: 'high',
		})
	})
	test('reuses a level only for the same tree, base and rules', () => {
		expect(getReusedLevel(MARKER, KEY)).toBe('medium')
		expect(
			getReusedLevel(MARKER, { ...KEY, base: 'f'.repeat(40) })
		).toBeUndefined()
		expect(
			getReusedLevel(MARKER, { ...KEY, tree: 'f'.repeat(40) })
		).toBeUndefined()
		expect(
			getReusedLevel(MARKER, { ...KEY, rules: 'f'.repeat(12) })
		).toBeUndefined()
	})
	test('a rebuild past the cap keeps a head granted again last and drops the oldest', () => {
		const heads = Array.from({ length: MAX_RATED_HEADS + 1 }, (_, index) =>
			index.toString(16).padStart(40, '0')
		)
		const order = [...heads, heads[0] ?? '']
		const statuses = order.flatMap((sha, index) =>
			toAppRiskStatuses(
				sha,
				[riskStatus({ id: index + 1, state: 'success' })],
				APP_ONLY,
				17
			)
		)
		const rebuilt = toRebuiltRiskMarker(
			statuses,
			new Map(heads.map(sha => [sha, RISK_TREE])),
			'none'
		)
		expect(rebuilt.heads).toHaveLength(MAX_RATED_HEADS)
		expect(rebuilt.heads.at(-1)?.head).toBe(heads[0])
		expect(rebuilt.heads.map(entry => entry.head)).not.toContain(heads[1])
		expect(rebuilt.heads[0]?.rules).toBe(RISK_DESCRIPTION.rules)
	})
	test('rebuilds entries from grants only and highest from errors plus the edited text', () => {
		const other = 'f'.repeat(40)
		const statuses = [
			...toAppRiskStatuses(
				RISK_HEAD,
				[
					riskStatus({ id: 1, state: 'success' }),
					riskStatus({ id: 2, state: 'success' }, { level: 'medium' }),
				],
				APP_ONLY,
				17
			),
			...toAppRiskStatuses(
				other,
				[riskStatus({ id: 3 }, { level: 'high' })],
				APP_ONLY,
				17
			),
		]
		expect(
			toRebuiltRiskMarker(
				statuses,
				new Map([
					[RISK_HEAD, RISK_TREE],
					[other, RISK_TREE],
				]),
				'none'
			)
		).toEqual({ v: 1, highest: 'high', heads: [ENTRY] })
		expect(toRebuiltRiskMarker([], new Map(), 'high')).toEqual({
			v: 1,
			highest: 'high',
			heads: [],
		})
		expect(toRebuiltRiskMarker(statuses, new Map(), 'none').heads).toEqual([])
	})
	test('raises highest, replaces the same head and retains only the last configured number of heads', () => {
		const heads = Array.from({ length: MAX_RATED_HEADS }, (_, index) => ({
			...ENTRY,
			head: index.toString(16).padStart(40, '0'),
		}))
		const next = toNextRiskMarker({ ...MARKER, highest: 'high', heads }, ENTRY)
		expect(next.highest).toBe('high')
		expect(next.heads).toHaveLength(MAX_RATED_HEADS)
		expect(next.heads.at(-1)).toEqual(ENTRY)
		expect(
			toNextRiskMarker(next, { ...ENTRY, level: 'high' }).heads.filter(
				entry => entry.head === RISK_HEAD
			)
		).toHaveLength(1)
	})
	test('only edits by the app since the read let a marker update stand', () => {
		expect(
			getMarkerEditStop(
				history([]),
				history([appEdit(2), appEdit(1)]),
				APP_IDENTITY
			)
		).toBeUndefined()
		const seen = [personEdit(4), appEdit(3), appEdit(2), appEdit(1)]
		expect(
			getMarkerEditStop(
				history(seen),
				history([appEdit(5), ...seen]),
				APP_IDENTITY
			)
		).toBeUndefined()
		const older = [appEdit(4), appEdit(3), appEdit(2), appEdit(1)]
		expect(
			getMarkerEditStop(
				history(older),
				history([appEdit(6), personEdit(5), ...older]),
				APP_IDENTITY
			)
		).toEqual(MARKER_RACE_STOP)
		expect(
			getMarkerEditStop(history(older), history(older), APP_IDENTITY)
		).toEqual(MARKER_UNSEEN_STOP)
	})
	test('an edit GitHub counts since the read but does not list stops the grant', () => {
		const older = Array.from({ length: 20 }, (_, index) => appEdit(20 - index))
		expect(
			getMarkerEditStop(
				history(older),
				{ total: 22, edits: [appEdit(21), ...older] },
				APP_IDENTITY
			)
		).toEqual(MARKER_PARTIAL_STOP)
	})
	test('an edit GitHub lists as a null node counts as an unknown editor', () => {
		expect(
			getMarkerEditStop(
				history([appEdit(3), appEdit(1)]),
				history([null, appEdit(4), appEdit(3), appEdit(1)]),
				APP_IDENTITY
			)
		).toEqual(MARKER_RACE_STOP)
		expect(
			getMarkerEditStop(
				history([appEdit(2), null]),
				history([appEdit(3), appEdit(2), null]),
				APP_IDENTITY
			)
		).toEqual(MARKER_RACE_STOP)
	})
	for (const order of ['newest first', 'oldest first'] as const)
		test(`picks the edits since the read by their id, listed ${order}`, () => {
			expect(
				getMarkerEditStop(
					history(listed(order, [appEdit(2), personEdit(1)])),
					history(listed(order, [appEdit(3), appEdit(2), personEdit(1)])),
					APP_IDENTITY
				)
			).toBeUndefined()
			expect(
				getMarkerEditStop(
					history(listed(order, [appEdit(2), appEdit(1)])),
					history(
						listed(order, [appEdit(4), personEdit(3), appEdit(2), appEdit(1)])
					),
					APP_IDENTITY
				)
			).toEqual(MARKER_RACE_STOP)
		})
	test('an edit in the same second as the update is told apart by its id', () => {
		expect(
			getMarkerEditStop(
				history([appEdit(1)]),
				history([appEdit(3), personEdit(3), appEdit(1)]),
				APP_IDENTITY
			)
		).toEqual(MARKER_RACE_STOP)
		expect(
			getMarkerEditStop(
				history([appEdit(1)]),
				history([appEdit(3), { ...appEdit(3), id: 'app-3b' }, appEdit(1)]),
				APP_IDENTITY
			)
		).toBeUndefined()
	})
	for (const total of [EDIT_RETENTION, EDIT_RETENTION + 40])
		test(`at the edit retention with a count of ${total}, only the app's update passes`, () => {
			const before = { total, edits: retained() }
			const kept = retained().slice(0, EDIT_RETENTION - 1)
			const counted = total === EDIT_RETENTION ? total : total + 1
			expect(
				getMarkerEditStop(
					before,
					{ total: counted, edits: [appEdit(59), ...kept] },
					APP_IDENTITY
				)
			).toBeUndefined()
			expect(
				getMarkerEditStop(
					before,
					{
						total: total === EDIT_RETENTION ? total : total + 2,
						edits: [appEdit(59), personEdit(58), ...kept.slice(0, -1)],
					},
					APP_IDENTITY
				)
			).toEqual(MARKER_RACE_STOP)
			expect(getMarkerEditStop(before, before, APP_IDENTITY)).toEqual(
				MARKER_UNSEEN_STOP
			)
		})
	test('a capped history that shares no edit with the read stops the grant', () => {
		const before = { total: EDIT_RETENTION, edits: retained() }
		const newer = Array.from({ length: EDIT_RETENTION }, (_, index) => ({
			...appEdit(1),
			id: `app-new-${index}`,
		}))
		expect(
			getMarkerEditStop(
				before,
				{ total: EDIT_RETENTION, edits: newer },
				APP_IDENTITY
			)
		).toEqual(MARKER_PARTIAL_STOP)
	})
	test('a capped history that keeps only the original of the read stops the grant', () => {
		const original = { ...personEdit(0), id: 'original' }
		const before = {
			total: EDIT_RETENTION,
			edits: [...retained().slice(0, EDIT_RETENTION - 1), original],
		}
		const newer = Array.from({ length: EDIT_RETENTION - 1 }, (_, index) => ({
			...appEdit(1),
			id: `app-new-${index}`,
		}))
		expect(
			getMarkerEditStop(
				before,
				{ total: EDIT_RETENTION, edits: [...newer, original] },
				APP_IDENTITY
			)
		).toEqual(MARKER_PARTIAL_STOP)
	})
	test('an empty read before the update needs only the app in the history after it', () => {
		expect(
			getMarkerEditStop(history([]), history([appEdit(2)]), APP_IDENTITY)
		).toBeUndefined()
		expect(
			getMarkerEditStop(
				history([]),
				history([appEdit(2), personEdit(1)]),
				APP_IDENTITY
			)
		).toEqual(MARKER_RACE_STOP)
	})
	test('reads a real two-page history GitHub returned', () => {
		const edits = getEditedCommentEdits()
		const bot = toBotIdentity(COMMENT_EDITS_BOT)
		const before = history(edits.slice(1))
		expect(getMarkerEditStop(before, history(edits), bot)).toBeUndefined()
		expect(
			getMarkerEditStop(before, history(edits.toReversed()), bot)
		).toBeUndefined()
		expect(getMarkerEditStop(before, history(edits), APP_IDENTITY)).toEqual(
			MARKER_RACE_STOP
		)
	})
})

/** A marker comment whose text names `level`, as a person could write it. */
function namedText(level: 'medium' | 'high') {
	return toMarkerComment('risk', { ...EMPTY_RISK_MARKER, highest: level })
}

describe('the level a rebuild overwrote', () => {
	const older = [appEdit(2), personEdit(1, namedText('medium'))]
	test('only the app editing since the read overwrote nothing', () => {
		expect(
			getOverwrittenLevel(
				history(older),
				history([appEdit(3), ...older]),
				APP_IDENTITY
			)
		).toBe('none')
	})
	for (const level of ['medium', 'high'] as const)
		test(`a person's edit since the read naming ${level} is carried`, () => {
			expect(
				getOverwrittenLevel(
					history(older),
					history([appEdit(4), personEdit(3, namedText(level)), ...older]),
					APP_IDENTITY
				)
			).toBe(level)
		})
	test("a person's edit that names no level carries nothing", () => {
		expect(
			getOverwrittenLevel(
				history(older),
				history([appEdit(4), personEdit(3, 'a note'), ...older]),
				APP_IDENTITY
			)
		).toBe('none')
	})
	test('an overwritten text GitHub does not give counts as High', () => {
		expect(
			getOverwrittenLevel(
				history(older),
				history([appEdit(4), { ...personEdit(3), diff: null }, ...older]),
				APP_IDENTITY
			)
		).toBe('high')
		expect(
			getOverwrittenLevel(
				history(older),
				history([appEdit(4), null, ...older]),
				APP_IDENTITY
			)
		).toBe('high')
		expect(
			getOverwrittenLevel(
				history(older),
				{ total: 4, edits: [appEdit(4), ...older] },
				APP_IDENTITY
			)
		).toBe('high')
		expect(
			getOverwrittenLevel(history(older), history(older), APP_IDENTITY)
		).toBe('high')
	})
})
