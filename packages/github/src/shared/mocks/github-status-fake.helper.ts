import {
	type ConfigError,
	DEFAULT_PRESET,
	RISK_STATUS_CONTEXT,
	toRiskDescription,
	type RiskDescription,
	type FloorDiff,
} from '@mng-review/domain'
import {
	FloorDiffService,
	GitService,
	type RiskRating,
} from '@mng-review/engine'
import { Effect, Layer } from 'effect'
import { PublishService } from '../../modules/publish/application/publish.service'
import type { BotThread } from '../../modules/publish/domain/publish.types'
import { AnswerReadService } from '../../modules/risk/application/answer-read.service'
import { RiskFinishServiceLive } from '../../modules/risk/application/risk-finish.service'
import { RiskReadServiceLive } from '../../modules/risk/application/risk-read.service'
import { RiskStartServiceLive } from '../../modules/risk/application/risk-start.service'
import type { FullRiskInput } from '../../modules/risk/domain/risk-run.types'
import {
	toBotIdentity,
	toOwnedIdentities,
} from '../../platform/bot-identity.helper'
import type { OpenPullRequest } from '../../platform/github-api.schema'
import type {
	CommentEdits,
	RiskCommitStatus,
	TimelineItem,
} from '../../platform/github-risk.schema'
import {
	GitHubRiskService,
	type RiskStatusInput,
} from '../../platform/github-risk.service'
import {
	GitHubStatusService,
	type CheckRunInput,
	type CommitStatusInput,
} from '../../platform/github-status.service'
import type { GitHubApiError } from '../../platform/github.errors'
import { OwnedIdentities } from '../../platform/owned-identities.context'
import { githubApiFake, COMMAND_PULL_REQUEST } from './github-api-fake.helper'
import { APP_IDENTITY, botThread, report, RULES } from './publish-test.helper'

/** An open pull request of this repository, as the pull request list answers it. */
export function openPullRequest(
	number: number,
	head: string,
	overrides: Partial<OpenPullRequest> = {}
): OpenPullRequest {
	return {
		number,
		base: { sha: 'b'.repeat(40), repo: { full_name: 'owner/repo' } },
		head: { sha: head, repo: { full_name: 'owner/repo' } },
		...overrides,
	}
}

/** In-memory status boundary records requests and allows per-operation failures without HTTP. */
export function githubStatusFake(
	overrides: Partial<GitHubStatusService['Service']> = {}
) {
	const checks: CheckRunInput[] = []
	const statuses: CommitStatusInput[] = []
	const heads: string[] = []
	return {
		checks,
		statuses,
		heads,
		layer: Layer.succeed(GitHubStatusService, {
			createCheckRun: input =>
				Effect.sync(() => {
					checks.push(input)
				}).pipe(
					Effect.andThen(() => overrides.createCheckRun?.(input) ?? Effect.void)
				),
			setStatus: input =>
				Effect.sync(() => {
					statuses.push(input)
				}).pipe(
					Effect.andThen(() => overrides.setStatus?.(input) ?? Effect.void)
				),
			getStatus: head =>
				Effect.sync(() => {
					heads.push(head)
				}).pipe(
					Effect.andThen(
						() => overrides.getStatus?.(head) ?? Effect.succeed(undefined)
					)
				),
			listOpenPullRequests:
				overrides.listOpenPullRequests ?? (() => Effect.succeed([])),
		}),
	}
}

/** The app the repository used before the current one, kept in `identity.previous`. */
export const PREVIOUS_APP_IDENTITY = toBotIdentity('old-review')
/** App mode after an app switch: the current app, the previous app and the job token. */
export const SWITCHED_APP_OWNED = Layer.succeed(OwnedIdentities, {
	current: APP_IDENTITY,
	identities: toOwnedIdentities(APP_IDENTITY, [
		PREVIOUS_APP_IDENTITY.login,
		...DEFAULT_PRESET.identity.previous,
	]),
})

export const RISK_HEAD = 'b'.repeat(40)
export const RISK_BASE = 'a'.repeat(40)
export const RISK_TREE = 'c'.repeat(40)
export const RISK_DESCRIPTION = {
	pr: 17,
	level: 'low',
	floor: false,
	base: RISK_BASE,
	rules: 'd'.repeat(12),
	nonce: 'e'.repeat(16),
} as const satisfies RiskDescription
export const RISK_RULES = {
	...RULES,
	config: {
		...DEFAULT_PRESET,
		risk: { ...DEFAULT_PRESET.risk, enabled: true },
	},
	risk: { rubric: 'Rate the complete change.', paths: ['.mng/risk.md'] },
} as const
export const LOW_RATING = {
	status: 'rated',
	head: RISK_HEAD,
	base: RISK_BASE,
	rules: RISK_DESCRIPTION.rules,
	floors: [],
	floor: false,
	level: 'low',
	model: 'low',
	reasons: ['A local change.'],
	refs: [],
	rater: 'fixture',
} as const satisfies RiskRating

/** A valid app status; callers independently select the number, state, level and creator. */
export function riskStatus(
	overrides: Partial<RiskCommitStatus> = {},
	description: Partial<RiskDescription> = {}
): RiskCommitStatus {
	return {
		id: 1,
		state: 'error',
		context: RISK_STATUS_CONTEXT,
		description: toRiskDescription({ ...RISK_DESCRIPTION, ...description }),
		created_at: '2026-01-01T00:00:00Z',
		creator: { login: APP_IDENTITY.restLogin, type: 'Bot' },
		...overrides,
	}
}

/** A bot bug thread whose finding validation confirmed, which the thread raise counts. */
export function confirmedThread(overrides: Partial<BotThread> = {}): BotThread {
	const thread = botThread(overrides)
	return { ...thread, marker: { ...thread.marker, confirmed: true } }
}

/** A full rating whose untrusted report binding can disagree with publish's git read. */
export function riskInput(
	overrides: Partial<FullRiskInput> = {}
): FullRiskInput {
	return {
		pullNumber: 17,
		head: RISK_HEAD,
		baseSha: RISK_BASE,
		defaultBranch: COMMAND_PULL_REQUEST.base.ref,
		rules: RISK_RULES,
		report: { ...report(), bugs: [], rating: LOW_RATING },
		...overrides,
	}
}

/** One risk write with the API writes already made when it happened. */
export interface RiskWrite extends RiskStatusInput {
	readonly apiWritesBefore: number
}

/** Recording, in-memory status API and git reads around the real risk services. */
export function riskFixture() {
	const api = githubApiFake(APP_IDENTITY)
	const statuses = new Map<string, RiskCommitStatus[]>()
	const items: TimelineItem[] = [
		{ __typename: 'PullRequestCommit', commit: { oid: RISK_HEAD } },
	]
	const threads: BotThread[] = []
	const writes: RiskWrite[] = []
	const reads: string[] = []
	const failures = {
		timeline: [] as GitHubApiError[],
		statuses: [] as (GitHubApiError | undefined)[],
		/** One entry per status create in turn; `undefined` lets that create pass. */
		create: [] as (GitHubApiError | undefined)[],
		/** A create GitHub stores and whose answer is then lost. */
		createStored: [] as GitHubApiError[],
		mergeBase: [] as ConfigError[],
		threads: [] as GitHubApiError[],
		/** One entry per edit history read in turn; `undefined` lets that read pass. */
		edits: [] as (GitHubApiError | undefined)[],
	}
	/** The edit history each read returns in turn; `undefined` reads it from the comments. */
	const editSnapshots: (CommentEdits | undefined)[] = []
	/** Run just before the next status create stores, like another writer landing first. */
	const beforeCreate: (() => void)[] = []
	/** Run just after the next timeline read returns, like a person acting right after it. */
	const afterTimeline: (() => void)[] = []
	const statusSnapshots: (readonly RiskCommitStatus[] | undefined)[] = []
	const gitState = {
		base: RISK_BASE,
		tree: RISK_TREE,
		diff: { intact: true, files: [] } as FloorDiff,
	}
	const risk = Layer.succeed(GitHubRiskService, {
		getRunCreated: () => Effect.die('unexpected run read'),
		listTimeline: () =>
			Effect.gen(function* () {
				reads.push('timeline')
				const error = failures.timeline.shift()
				if (error) return yield* error
				const read = [...items]
				afterTimeline.shift()?.()
				return read
			}),
		listStatuses: sha =>
			Effect.gen(function* () {
				reads.push(sha)
				const error = failures.statuses.shift()
				if (error) return yield* error
				return statusSnapshots.shift() ?? [...(statuses.get(sha) ?? [])]
			}),
		createStatus: input =>
			Effect.gen(function* () {
				writes.push({ ...input, apiWritesBefore: api.writes.length })
				beforeCreate.shift()?.()
				const error = failures.create.shift()
				if (error) return yield* error
				const prior = [...statuses.values()].flat()
				const id = Math.max(0, ...prior.map(status => status.id)) + 1
				statuses.set(input.sha, [
					riskStatus({
						id,
						state: input.state,
						description: input.description,
					}),
					...(statuses.get(input.sha) ?? []),
				])
				const lost = failures.createStored.shift()
				if (lost) return yield* lost
				return undefined
			}),
		readCommentEdits: nodeId =>
			Effect.gen(function* () {
				reads.push(`edits:${nodeId}`)
				const error = failures.edits.shift()
				if (error) return yield* error
				const snapshot = editSnapshots.shift()
				if (snapshot) return snapshot
				const comment = api.comments.find(entry => entry.id === nodeId)
				const updates = api.writes.filter(
					write => write.method === 'update' && write.id === comment?.databaseId
				).length
				// GitHub lists the created version too once a comment is first edited.
				const total = updates === 0 ? 0 : updates + 1
				return {
					body: comment?.body ?? '',
					total,
					edits: Array.from({ length: total }, (_, index) => ({
						id: `edit-${total - 1 - index}`,
						editor: { __typename: 'Bot', login: APP_IDENTITY.login },
						editedAt: `2026-01-01T00:${String(59 - index).padStart(2, '0')}:00Z`,
						diff: comment?.body ?? '',
					})),
				} satisfies CommentEdits
			}),
	})
	const git = Layer.succeed(GitService, {
		root: '/fixture',
		mergeBase: (base, head) =>
			Effect.gen(function* () {
				reads.push(`mergeBase:${base}:${head}`)
				const error = failures.mergeBase.shift()
				if (error) return yield* error
				return gitState.base
			}),
		exec: args =>
			Effect.sync(() => {
				reads.push(args.join(' '))
				return { exitCode: 0, stdout: gitState.tree, stderr: '' }
			}),
		resolveCommit: () => Effect.die('unexpected resolveCommit'),
		branchName: () => Effect.die('unexpected branchName'),
		readChange: () => Effect.die('unexpected readChange'),
		readDiff: () => Effect.die('unexpected readDiff'),
		readFileAt: () => Effect.die('unexpected readFileAt'),
		foldLines: () => Effect.die('unexpected foldLines'),
		listFilesAt: () => Effect.die('unexpected listFilesAt'),
		getFilesAt: () => Effect.die('unexpected getFilesAt'),
	})
	const dependencies = Layer.mergeAll(
		api.api,
		risk,
		git,
		Layer.succeed(FloorDiffService, {
			read: range =>
				Effect.sync(() => {
					reads.push(`floors:${range.base}:${range.head}`)
					return gitState.diff
				}),
		}),
		Layer.succeed(PublishService, {
			readThreads: () =>
				Effect.gen(function* () {
					const error = failures.threads.shift()
					if (error) return yield* error
					return [...threads]
				}),
			publish: () => Effect.die('unexpected publish'),
		})
	)
	const readLayer = RiskReadServiceLive.pipe(Layer.provide(dependencies))
	const services = Layer.mergeAll(
		RiskStartServiceLive,
		RiskFinishServiceLive,
		// The publish layer's specs name no commands; the holds specs use the real answer reads.
		Layer.succeed(AnswerReadService, {
			readCommands: () => Effect.succeed({ commands: [], entries: [] }),
			getCommandEntry: () => Effect.succeed(undefined),
			getCountedReviews: () => Effect.succeed([]),
		})
	).pipe(Layer.provideMerge(readLayer), Layer.provideMerge(dependencies))
	api.command.pullRequest = structuredClone(COMMAND_PULL_REQUEST)
	return {
		api,
		statuses,
		items,
		threads,
		writes,
		reads,
		failures,
		beforeCreate,
		afterTimeline,
		statusSnapshots,
		editSnapshots,
		gitState,
		risk,
		readLayer,
		services,
	}
}
