import {
	type AnswerEntry,
	type KeptFinding,
	toFinding,
	toFingerprint,
	DEFAULT_PRESET,
	buildPlan,
} from '@mng-review/domain'
import { toEmptyReviewReport } from '@mng-review/engine'
import { Layer } from 'effect'
import type { SummaryMarker } from '../../modules/publish/domain/publish-marker.schema'
import { MARKER_VERSION } from '../../modules/publish/domain/publish.constants'
import type {
	BotThread,
	PublishedFinding,
} from '../../modules/publish/domain/publish.types'
import type { ReviewEvidence } from '../../modules/publish/domain/review-event.helper'
import {
	formatResolvedReply,
	toFindingMarker,
	toMarkerComment,
	type BlobLinks,
} from '../../modules/publish/presentation/thread-comment.formatter'
import {
	GITHUB_ACTIONS_IDENTITY,
	toBotIdentity,
	toOwnedIdentities,
} from '../../platform/bot-identity.helper'
import type {
	ReviewThread,
	ThreadComment,
	PullRequestComment,
	PullRequestReview,
} from '../../platform/github-api.schema'
import { OwnedIdentities } from '../../platform/owned-identities.context'
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
/** `RULES` with `intentional` replies accepted up to `high`, the shared bug's severity. */
export const ACCEPTING_RULES = {
	...RULES,
	config: {
		...DEFAULT_PRESET,
		disputes: { ...DEFAULT_PRESET.disputes, accept_intentional_up_to: 'high' },
	},
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

/** A title over the title limit, as the model reported it. */
const UNCUT_TITLE =
	'Duplicate write loses data when a retried request reaches the store after the first write already committed its row'
/** `UNCUT_TITLE` as the answer parser cuts it. */
const CUT_TITLE =
	'Duplicate write loses data when a retried request reaches the store after the first write already…'

/** A bug whose over-long title the answer parser cut, attributed as the finder attributes it. */
export function cutTitleBug(): KeptFinding {
	const { path, line } = bug()
	return {
		...toFinding(
			{
				path,
				line,
				severity: 'high',
				title: CUT_TITLE,
				uncutTitle: UNCUT_TITLE,
				trigger: 'A write is retried.',
				impact: 'Data is overwritten.',
				evidence: [`${path}:${line}`],
			},
			{ agent: 'reviewer', model: 'model-a', kind: 'bug' }
		),
		placement: 'inline',
	}
}

/** The fingerprint a thread of `cutTitleBug()` carries when it was posted from the cut title. */
export function cutTitleFingerprint(): string {
	return toFingerprint({ path: bug().path, title: CUT_TITLE })
}

/** A minimal reviewed report without an endpoint or model call. */
export function report() {
	const input = planInput({ config: DEFAULT_PRESET })
	const plan = buildPlan(input, { status: 'ok', risk: 'normal', added: [] })
	return {
		...toEmptyReviewReport(
			{
				change: {
					base: { ref: 'main', commit: 'base' },
					head: { ref: 'HEAD', commit: 'head' },
					mergeBase: 'base',
					files: input.files,
				},
				plan,
				rulesSource: 'base',
				tokens: {},
			},
			0
		),
		// Every planned run reported, so only what a test changes makes the run fail.
		agents: plan.runs.map(run => ({ ...agentReport(), name: run.name })),
		bugs: [bug()],
	}
}

/** A bot-owned open line thread matching the default finding. */
export function botThread(overrides: Partial<BotThread> = {}): BotThread {
	return {
		id: 'thread',
		resolved: false,
		closedByBot: false,
		onFile: false,
		path: bug().path,
		line: bug().line,
		originalLine: bug().line,
		commit: 'head',
		marker: toFindingMarker({ finding: bug(), kind: 'bug' }, LINKS),
		replies: 0,
		latestCommentId: undefined,
		latestAuthor: undefined,
		latestMarked: true,
		latestDigest: undefined,
		closedAt: undefined,
		sentToOwner: false,
		unsettled: false,
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
					author: { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login },
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

type AgentRunReport = ReturnType<typeof toEmptyReviewReport>['agents'][number]

/** Complete agent report for a planned model, with independently selectable outcome. */
export function agentReport(
	status: AgentRunReport['status'] = 'ok'
): AgentRunReport {
	return {
		name: 'reviewer',
		title: 'Main reviewer',
		kind: 'bug',
		model: 'model-a',
		effort: 'high',
		status,
		toolCalls: 0,
		findings: 0,
		malformed: 0,
		wallMillis: 1,
	}
}

/** The bot's closing reply, with overrides for author and editor trust tests. */
export function threadReply(
	overrides: Partial<ThreadComment> = {}
): ThreadComment {
	return {
		databaseId: 2,
		body: formatResolvedReply('The write is guarded.', LINKS),
		author: { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login },
		editor: null,
		originalCommit: { oid: LINKS.head },
		...overrides,
	}
}

/** GitHub still shows this thread open after the bot posted its closing reply. */
export function botClosedReviewThread(
	overrides: Partial<ReviewThread> = {}
): ReviewThread {
	const thread = reviewThread()
	return {
		...thread,
		comments: { ...thread.comments, totalCount: 2 },
		latest: { nodes: [threadReply()] },
		...overrides,
	}
}

/** Token mode with the preset's `identity.previous`: only `github-actions` is owned. */
export const TOKEN_MODE_OWNED = Layer.succeed(OwnedIdentities, {
	current: GITHUB_ACTIONS_IDENTITY,
	identities: [GITHUB_ACTIONS_IDENTITY],
})

/** The public app used by identity-switch specs. */
export const APP_IDENTITY = toBotIdentity('mng-review')
/** App mode retains the preset's job-token identity. */
export const APP_MODE_IDENTITIES = toOwnedIdentities(
	APP_IDENTITY,
	DEFAULT_PRESET.identity.previous
)
export const APP_MODE_OWNED = Layer.succeed(OwnedIdentities, {
	current: APP_IDENTITY,
	identities: APP_MODE_IDENTITIES,
})

/** An app-authored conversation summary, with independently selectable marker and trust fields. */
export function appSummary(
	marker: SummaryMarker = SUMMARY_MARKER,
	overrides: Partial<PullRequestComment> = {}
): PullRequestComment {
	return {
		id: 'app-summary',
		databaseId: 100,
		isMinimized: false,
		body: toMarkerComment('summary', marker),
		author: { __typename: 'Bot', login: APP_IDENTITY.login },
		editor: null,
		...overrides,
	}
}

/** A summary review with independently selectable state, author and marker. */
export function summaryReview(
	marker: SummaryMarker = SUMMARY_MARKER,
	overrides: Partial<PullRequestReview> = {}
): PullRequestReview {
	return {
		id: 'summary-review',
		databaseId: 101,
		state: 'COMMENTED',
		isMinimized: false,
		body: toMarkerComment('summary', marker),
		author: { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login },
		editor: null,
		...overrides,
	}
}

/** The evidence of a push that finished on the current head and covered the change. */
export const COVERED_REVIEW = {
	kind: 'review',
	verdict: 'ready',
	openBugs: 0,
	onHead: true,
	full: true,
	failed: false,
	gap: undefined,
	approval: 'allowed',
	authored: false,
} as const satisfies ReviewEvidence

/**
 * `count` `review` answer entries naming one comment each, runs and comment ids counting up from
 * `first`; `width` pads each run id to that many digits, the size of a real one.
 */
export function reviewAnswers(
	count: number,
	first = 1,
	width = 1
): AnswerEntry[] {
	return Array.from({ length: count }, (_, index) => ({
		run: Number(String(first + index).padStart(width, '9')),
		kind: 'review',
		ids: [
			{
				id: Number(String(first + index).padStart(width, '9')),
				at: '2026-01-01T12:00:00Z',
				digest: 'a'.repeat(16),
			},
		],
	}))
}
