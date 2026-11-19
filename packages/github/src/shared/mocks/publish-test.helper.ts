import {
	type KeptFinding,
	toFinding,
	DEFAULT_PRESET,
	buildPlan,
} from '@mng-review/domain'
import { toEmptyReviewReport } from '@mng-review/engine'
import {
	MARKER_VERSION,
	BOT_LOGIN,
} from '../../modules/publish/domain/publish.constants'
import type {
	BotThread,
	PublishedFinding,
} from '../../modules/publish/domain/publish.types'
import {
	toFindingMarker,
	toMarkerComment,
	type BlobLinks,
} from '../../modules/publish/presentation/thread-comment.formatter'
import type { ReviewThread } from '../../platform/github-api.schema'
import { planInput } from '../../shared/mocks/domain-test.helper'

export const LINKS = {
	serverUrl: 'https://github.com',
	owner: 'example',
	name: 'project',
	head: 'head',
	engineCommit: 'engine',
} as const satisfies BlobLinks
export const RULES = {
	config: DEFAULT_PRESET,
	agents: [],
	source: 'base',
} as const

/** A publishable bug with independently overridable placement and validation. */
export function bug(overrides: Partial<KeptFinding> = {}): KeptFinding {
	return {
		...toFinding(
			{
				path: 'src/store.ts',
				line: 10,
				severity: 'high',
				title: 'Duplicate write loses data',
				trigger: 'A write is retried.',
				impact: 'Data is overwritten.',
				evidence: ['src/store.ts:10'],
			},
			{ agent: 'reviewer', model: 'model-a', kind: 'bug' }
		),
		placement: 'inline',
		...overrides,
	}
}

/** A minimal reviewed report without an endpoint or model call. */
export function report() {
	const input = planInput({ config: DEFAULT_PRESET })
	return {
		...toEmptyReviewReport(
			{
				change: {
					base: { ref: 'main', commit: 'base' },
					head: { ref: 'HEAD', commit: 'head' },
					mergeBase: 'base',
					files: input.files,
				},
				plan: buildPlan(input, { status: 'ok', risk: 'normal', added: [] }),
				rulesSource: 'base',
				tokens: {},
			},
			0
		),
		bugs: [bug()],
	}
}

/** A bot-owned open line thread matching the default finding. */
export function botThread(overrides: Partial<BotThread> = {}): BotThread {
	return {
		id: 'thread',
		resolved: false,
		onFile: false,
		path: bug().path,
		line: bug().line,
		originalLine: bug().line,
		commit: 'head',
		marker: toFindingMarker({ finding: bug(), kind: 'bug' }, LINKS),
		replies: 0,
		...overrides,
	}
}

const DEFAULT_PUBLISHED = {
	finding: bug(),
	kind: 'bug',
} as const satisfies PublishedFinding

/** GraphQL thread fixture retains the author and editor trust boundary. */
export function reviewThread(
	published: PublishedFinding = DEFAULT_PUBLISHED,
	overrides: Partial<ReviewThread> = {}
): ReviewThread {
	return {
		id: 'thread',
		isResolved: false,
		isOutdated: false,
		path: published.finding.path,
		line: published.finding.line,
		originalLine: published.finding.line,
		subjectType: 'LINE',
		comments: {
			totalCount: 1,
			nodes: [
				{
					databaseId: 1,
					body: toMarkerComment('finding', toFindingMarker(published, LINKS)),
					author: { __typename: 'Bot', login: BOT_LOGIN },
					editor: null,
					originalCommit: { oid: LINKS.head },
				},
			],
		},
		...overrides,
	}
}

export const SUMMARY_MARKER = {
	v: MARKER_VERSION,
	runs: 1,
	head: LINKS.head,
} as const
