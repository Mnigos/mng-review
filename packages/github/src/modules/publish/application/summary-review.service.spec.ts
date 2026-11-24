import { layer } from '@effect/vitest'
import type { AnswerEntry } from '@mng-review/domain'
import { Effect, Layer } from 'effect'
import {
	GITHUB_ACTIONS_IDENTITY,
	type BotIdentity,
} from '../../../platform/bot-identity.helper'
import { GitHubConfig } from '../../../platform/github.config'
import { GitHubApiError } from '../../../platform/github.errors'
import {
	githubApiFake,
	type GitHubApiFakeOptions,
} from '../../../shared/mocks/github-api-fake.helper'
import { GITHUB_SETTINGS } from '../../../shared/mocks/github-http.helper'
import {
	githubStatusFake,
	openPullRequest,
} from '../../../shared/mocks/github-status-fake.helper'
import {
	APP_IDENTITY,
	APP_MODE_OWNED,
	appSummary,
	COVERED_REVIEW,
	reviewAnswers,
	SUMMARY_MARKER,
	summaryReview,
	TOKEN_MODE_OWNED,
} from '../../../shared/mocks/publish-test.helper'
import {
	StatusSweepService,
	StatusSweepServiceLive,
} from '../../status/application/status-sweep.service'
import { toCommitStatus } from '../../status/domain/status.helper'
import { parseSummaryMarker } from '../domain/publish-marker.parser'
import { MAX_ANSWER_ENTRIES } from '../domain/publish.constants'
import { toMarkerComment } from '../presentation/thread-comment.formatter'
import {
	SummaryReviewService,
	SummaryReviewServiceLive,
} from './summary-review.service'
import type { SummaryDraft } from './summary-review.service.types'

const NO_DISMISSAL = { dismissed: 0, failed: 0 } as const
const TARGET = { pullNumber: 17, head: 'head', engineCommit: 'engine' } as const
const RESERVE = { ...TARGET, maxRuns: 5, handle: 'review-bot' } as const
const INLINE = [{ path: 'src/example.ts', line: 7, body: 'Finding' }] as const

/** Records the prior marker and whether fallback rendering was requested. */
function draft(overrides: Partial<SummaryDraft> = {}): SummaryDraft {
	return {
		head: TARGET.head,
		render: (prior, inline) => {
			const marker = {
				...prior?.marker,
				v: SUMMARY_MARKER.v,
				runs: (prior?.marker.runs ?? 0) + 1,
			}
			return {
				marker,
				body: `${inline ? 'Review' : 'Not in the diff'}\n${toMarkerComment('summary', marker)}`,
				evidence: { ...COVERED_REVIEW, gap: { kind: 'findings', findings: 1 } },
			}
		},
		...overrides,
	}
}

/** A draft whose summary marker carries `answers`. */
function answered(answers: readonly AnswerEntry[]): SummaryDraft {
	const base = draft()
	return {
		...base,
		render: (prior, inline, moved) => {
			const rendered = base.render(prior, inline, moved)
			const marker = { ...rendered.marker, answers }
			return { ...rendered, marker, body: toMarkerComment('summary', marker) }
		},
	}
}

/** In-memory publishing dependencies, without Git or HTTP. */
function setup(
	options: GitHubApiFakeOptions = {},
	identity: BotIdentity = GITHUB_ACTIONS_IDENTITY
) {
	const fake = githubApiFake(identity, options)
	fake.command.pullRequest = {
		...fake.command.pullRequest,
		head: { ...fake.command.pullRequest.head, sha: TARGET.head },
	}
	return {
		fake,
		layer: SummaryReviewServiceLive.pipe(
			Layer.provide(
				Layer.merge(
					fake.api,
					Layer.succeed(GitHubConfig, { ...GITHUB_SETTINGS, identity })
				)
			)
		),
	}
}

/** A GitHub response failure, or an unknown transport result when status is absent. */
function failure(status?: number) {
	return new GitHubApiError({
		operation: 'fixture',
		reason: 'Unavailable',
		...(status === undefined ? {} : { status }),
	})
}

layer(TOKEN_MODE_OWNED)('SummaryReviewService', test => {
	test.effect(
		'edits the newest visible COMMENTED summary when no threads were posted',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.fake.reviews.push(
					summaryReview(),
					summaryReview(
						{ ...SUMMARY_MARKER, runs: 4 },
						{ id: 'newest', databaseId: 102 }
					)
				)
				const written = yield* SummaryReviewService.use(service =>
					service.write(17, draft())
				).pipe(Effect.provide(fixture.layer))
				expect(written).toMatchObject({
					created: false,
					inline: true,
					cleanup: 'minimized',
					marker: { runs: 5 },
				})
				expect(fixture.fake.writes).toEqual([
					{ method: 'updateReview', id: 102, body: written.body },
					{ method: 'minimize', id: 'summary-review' },
				])
			})
	)
	for (const state of [
		'APPROVED',
		'CHANGES_REQUESTED',
		'DISMISSED',
		'PENDING',
	] as const)
		test.effect(`creates instead of editing a ${state} review`, () =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.fake.reviews.push(summaryReview(SUMMARY_MARKER, { state }))
				expect(
					yield* SummaryReviewService.use(service =>
						service.write(17, draft())
					).pipe(Effect.provide(fixture.layer))
				).toMatchObject({ created: true })
				expect(fixture.fake.writes.map(write => write.method)).toEqual([
					'review',
					'minimize',
					...(state === 'CHANGES_REQUESTED' || state === 'APPROVED'
						? ['dismissReview']
						: []),
				])
			})
		)
	for (const condition of ['hidden', 'fresh', 'inline', 'absent'] as const)
		test.effect(`creates a COMMENT review when the prior is ${condition}`, () =>
			Effect.gen(function* () {
				const fixture = setup()
				if (condition !== 'absent')
					fixture.fake.reviews.push(
						summaryReview(SUMMARY_MARKER, {
							isMinimized: condition === 'hidden',
						})
					)
				const written = yield* SummaryReviewService.use(service =>
					service.write(
						17,
						draft({
							...(condition === 'fresh' ? { fresh: true } : {}),
							...(condition === 'inline' ? { comments: INLINE } : {}),
						})
					)
				).pipe(Effect.provide(fixture.layer))
				expect(written.created).toBe(true)
				expect(fixture.fake.writes[0]).toMatchObject({
					method: 'review',
					pullNumber: 17,
					input: {
						commitId: 'head',
						event: 'COMMENT',
						body: written.body,
						comments: condition === 'inline' ? INLINE : [],
					},
				})
				expect(
					fixture.fake.writes.some(write => write.method === 'updateReview')
				).toBe(false)
			})
		)
	test.effect(
		'a 404 edit creates a review and carries the original marker',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.fake.reviews.push(
					summaryReview({ ...SUMMARY_MARKER, manualRuns: 3 })
				)
				fixture.fake.failures.updateReview.push(failure(404))
				expect(
					yield* SummaryReviewService.use(service =>
						service.write(17, draft())
					).pipe(Effect.provide(fixture.layer))
				).toMatchObject({ created: true, marker: { runs: 2, manualRuns: 3 } })
				expect(fixture.fake.writes.map(write => write.method)).toEqual([
					'updateReview',
					'review',
					'minimize',
				])
			})
	)
	test.effect(
		'a non-404 edit failure propagates without a create or cleanup',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.fake.reviews.push(summaryReview())
				const error = failure(403)
				fixture.fake.failures.updateReview.push(error)
				expect(
					yield* SummaryReviewService.use(service =>
						service.write(17, draft())
					).pipe(Effect.provide(fixture.layer), Effect.flip)
				).toBe(error)
				expect(fixture.fake.writes.map(write => write.method)).toEqual([
					'updateReview',
				])
			})
	)
	test.effect('a render at the answer cap writes its summary', () =>
		Effect.gen(function* () {
			const fixture = setup()
			const answers = reviewAnswers(MAX_ANSWER_ENTRIES)
			const written = yield* SummaryReviewService.use(service =>
				service.write(17, answered(answers))
			).pipe(Effect.provide(fixture.layer))
			expect(parseSummaryMarker(written.body)?.answers).toEqual(answers)
			expect(fixture.fake.writes.map(write => write.method)).toEqual(['review'])
		})
	)
	test.effect(
		'a render past the answer cap fails closed and writes nothing',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.fake.reviews.push(summaryReview())
				expect(
					yield* SummaryReviewService.use(service =>
						service.write(17, answered(reviewAnswers(MAX_ANSWER_ENTRIES + 1)))
					).pipe(Effect.provide(fixture.layer), Effect.flip)
				).toMatchObject({
					_tag: 'SummaryMarkerError',
					answers: MAX_ANSWER_ENTRIES + 1,
				})
				expect(fixture.fake.writes).toEqual([])
			})
	)
	test.effect(
		'a refused inline review rerenders findings in the body and creates without comments',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.fake.failures.review.push(failure(422))
				const written = yield* SummaryReviewService.use(service =>
					service.write(17, draft({ comments: INLINE }))
				).pipe(Effect.provide(fixture.layer))
				expect(written).toMatchObject({ created: true, inline: false })
				expect(written.body).toContain('Not in the diff')
				expect(fixture.fake.writes).toMatchObject([
					{ method: 'review', input: { comments: INLINE } },
					{ method: 'review', input: { comments: [], body: written.body } },
				])
				expect(fixture.fake.threads).toEqual([])
			})
	)
	for (const status of [undefined, 503])
		for (const stored of [false, true])
			test.effect(
				`unknown create status=${status} stored=${stored} rereads once without reposting`,
				() =>
					Effect.gen(function* () {
						const fixture = setup({ storeFailedCreates: stored })
						const error = failure(status)
						fixture.fake.failures.review.push(error)
						const outcome = yield* SummaryReviewService.use(service =>
							service.write(17, draft())
						).pipe(Effect.provide(fixture.layer), Effect.result)
						if (stored)
							expect(outcome).toMatchObject({
								_tag: 'Success',
								success: { created: true },
							})
						else
							expect(outcome).toMatchObject({ _tag: 'Failure', failure: error })
						expect(fixture.fake.reviewReads).toEqual([17, 17])
						expect(fixture.fake.writes.map(write => write.method)).toEqual([
							'review',
						])
					})
			)
	for (const mismatch of [
		'known',
		'foreign',
		'body',
		'no database id',
	] as const)
		test.effect(`unknown create does not accept a ${mismatch} review`, () =>
			Effect.gen(function* () {
				const fixture = setup()
				const { body } = draft().render(undefined, true, false)
				const candidate = summaryReview(SUMMARY_MARKER, {
					body,
					...(mismatch === 'foreign'
						? { author: { __typename: 'Bot', login: 'foreign' } }
						: {}),
					...(mismatch === 'body' ? { body: 'Different' } : {}),
					...(mismatch === 'no database id' ? { databaseId: null } : {}),
				})
				fixture.fake.reviewSnapshots.push(
					mismatch === 'known' ? [candidate] : [],
					[candidate]
				)
				const error = failure(502)
				fixture.fake.failures.review.push(error)
				expect(
					yield* SummaryReviewService.use(service =>
						service.write(17, draft({ fresh: true }))
					).pipe(Effect.provide(fixture.layer), Effect.flip)
				).toBe(error)
				expect(fixture.fake.writes).toHaveLength(1)
			})
		)
	test.effect(
		'a permanent create refusal with no inline comments does not retry or clean up',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				const error = failure(422)
				fixture.fake.failures.review.push(error)
				expect(
					yield* SummaryReviewService.use(service =>
						service.write(17, draft())
					).pipe(Effect.provide(fixture.layer), Effect.flip)
				).toBe(error)
				expect(fixture.fake.reviewReads).toEqual([17])
				expect(fixture.fake.writes).toHaveLength(1)
			})
	)
	test.effect(
		'migration carries the old marker and waiting list before hiding the sticky comment',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.fake.comments.push(
					appSummary(
						{
							...SUMMARY_MARKER,
							runs: 6,
							manualRuns: 2,
							needsOwner: ['waiting'],
						},
						{
							author: {
								__typename: 'Bot',
								login: GITHUB_ACTIONS_IDENTITY.login,
							},
						}
					)
				)
				const written = yield* SummaryReviewService.use(service =>
					service.write(17, draft())
				).pipe(Effect.provide(fixture.layer))
				expect(written.marker).toMatchObject({
					runs: 7,
					manualRuns: 2,
					needsOwner: ['waiting'],
				})
				expect(fixture.fake.writes.map(write => write.method)).toEqual([
					'review',
					'minimize',
				])
				expect(fixture.fake.comments[0]?.isMinimized).toBe(true)
			})
	)
	for (const status of [403, 404, 422, 503])
		test.effect(
			`legacy comment minimize failure ${status} only deletes on a declined request`,
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.comments.push(
						appSummary(SUMMARY_MARKER, {
							author: {
								__typename: 'Bot',
								login: GITHUB_ACTIONS_IDENTITY.login,
							},
						})
					)
					fixture.fake.failures.minimize.push(failure(status))
					const declined = status !== 503
					expect(
						yield* SummaryReviewService.use(service =>
							service.write(17, draft())
						).pipe(Effect.provide(fixture.layer))
					).toMatchObject({ cleanup: declined ? 'deleted' : 'kept' })
					expect(fixture.fake.writes.map(write => write.method)).toEqual(
						declined ? ['review', 'minimize', 'delete'] : ['review', 'minimize']
					)
				})
		)
	for (const status of [404, 503])
		test.effect(
			`legacy comment delete ${status} reports its cleanup outcome`,
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.comments.push(
						appSummary(SUMMARY_MARKER, {
							author: {
								__typename: 'Bot',
								login: GITHUB_ACTIONS_IDENTITY.login,
							},
						})
					)
					fixture.fake.failures.minimize.push(failure(403))
					fixture.fake.failures.delete.push(failure(status))
					expect(
						yield* SummaryReviewService.use(service =>
							service.write(17, draft())
						).pipe(Effect.provide(fixture.layer))
					).toMatchObject({ cleanup: status === 404 ? 'deleted' : 'kept' })
				})
		)
	test.effect(
		'cleanup hides old non-summary reviews and reports the worst failure without deleting a review',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.fake.reviews.push(
					summaryReview(SUMMARY_MARKER, {
						id: 'old-inline',
						databaseId: 99,
						body: '2 new comments',
					}),
					summaryReview()
				)
				fixture.fake.comments.push(
					appSummary(SUMMARY_MARKER, {
						author: { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login },
					})
				)
				fixture.fake.failures.minimize.push(failure(403), failure(403))
				expect(
					yield* SummaryReviewService.use(service =>
						service.write(17, draft())
					).pipe(Effect.provide(fixture.layer))
				).toMatchObject({ cleanup: 'kept' })
				expect(fixture.fake.writes.map(write => write.method)).toEqual([
					'updateReview',
					'minimize',
					'minimize',
					'delete',
				])
				expect(fixture.fake.writes).toContainEqual({
					method: 'delete',
					id: 100,
				})
			})
	)
	for (const state of ['COMMENTED', 'DISMISSED'] as const)
		test.effect(
			`readPrior uses a hidden ${state} review ahead of an old comment`,
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const marker = { ...SUMMARY_MARKER, runs: 7, manualRuns: 4 }
					fixture.fake.reviews.push(
						summaryReview(marker, { state, isMinimized: true })
					)
					fixture.fake.comments.push(appSummary())
					expect(
						yield* SummaryReviewService.use(service =>
							service.readPrior(17)
						).pipe(Effect.provide(fixture.layer))
					).toEqual(marker)
					expect(fixture.fake.commentReads).toEqual([])
				})
		)
	test.effect(
		'readWaiting unions hidden reviews and legacy comments and rejects a human-edited marker',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.fake.reviews.push(
					summaryReview(
						{ ...SUMMARY_MARKER, needsOwner: ['review', 'shared'] },
						{ isMinimized: true }
					),
					summaryReview(
						{ ...SUMMARY_MARKER, needsOwner: ['forged'] },
						{ editor: { __typename: 'User', login: 'writer' } }
					)
				)
				fixture.fake.comments.push(
					appSummary(
						{ ...SUMMARY_MARKER, needsOwner: ['comment', 'shared'] },
						{
							isMinimized: true,
							author: {
								__typename: 'Bot',
								login: GITHUB_ACTIONS_IDENTITY.login,
							},
						}
					)
				)
				expect(
					yield* SummaryReviewService.use(service =>
						service.readWaiting(17)
					).pipe(Effect.provide(fixture.layer))
				).toEqual(['review', 'shared', 'comment'])
			})
	)
	for (const state of ['COMMENTED', 'DISMISSED', 'CHANGES_REQUESTED'] as const)
		test.effect(
			`reservation edits a hidden own ${state} review without cleanup`,
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.reviews.push(
						summaryReview(
							{ ...SUMMARY_MARKER, manualRuns: 2, needsOwner: ['waiting'] },
							{ state, isMinimized: true }
						)
					)
					expect(
						yield* SummaryReviewService.use(service =>
							service.reserveManualRun(RESERVE)
						).pipe(Effect.provide(fixture.layer))
					).toBe(true)
					expect(fixture.fake.writes.map(write => write.method)).toEqual([
						'updateReview',
					])
					expect(
						parseSummaryMarker(fixture.fake.reviews[0]?.body ?? '')
					).toEqual({
						...SUMMARY_MARKER,
						manualRuns: 3,
						needsOwner: ['waiting'],
					})
				})
		)
	test.effect(
		'reservation edits the current identity legacy comment when no review exists',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.fake.comments.push(
					appSummary(SUMMARY_MARKER, {
						author: { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login },
					})
				)
				expect(
					yield* SummaryReviewService.use(service =>
						service.reserveManualRun(RESERVE)
					).pipe(Effect.provide(fixture.layer))
				).toBe(true)
				expect(fixture.fake.writes.map(write => write.method)).toEqual([
					'update',
				])
				expect(
					parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
				).toMatchObject({ manualRuns: 1, runs: 1 })
			})
	)
	test.effect(
		'reservation without a prior creates a status review without cleanup',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				expect(
					yield* SummaryReviewService.use(service =>
						service.reserveManualRun(RESERVE)
					).pipe(Effect.provide(fixture.layer))
				).toBe(true)
				expect(fixture.fake.writes.map(write => write.method)).toEqual([
					'review',
				])
				expect(fixture.fake.reviews[0]?.body).toContain('`@review-bot`')
				expect(
					parseSummaryMarker(fixture.fake.reviews[0]?.body ?? '')
				).toMatchObject({ runs: 0, manualRuns: 1 })
			})
	)
	for (const count of [5, 6])
		test.effect(`reservation at manual cap ${count} writes nothing`, () =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.fake.reviews.push(
					summaryReview({ ...SUMMARY_MARKER, manualRuns: count })
				)
				expect(
					yield* SummaryReviewService.use(service =>
						service.reserveManualRun(RESERVE)
					).pipe(Effect.provide(fixture.layer))
				).toBe(false)
				expect(fixture.fake.writes).toEqual([])
			})
		)
	test.effect(
		'offline status edits the review body and retains the reviewed marker as unfinished',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.fake.reviews.push(summaryReview())
				expect(
					yield* SummaryReviewService.use(service =>
						service.publishStatus({ ...TARGET, status: 'offline' })
					).pipe(Effect.provide(fixture.layer))
				).toMatchObject({ created: false })
				expect(parseSummaryMarker(fixture.fake.reviews[0]?.body ?? '')).toEqual(
					{ ...SUMMARY_MARKER, finished: false }
				)
				expect(fixture.fake.writes.map(write => write.method)).toEqual([
					'updateReview',
				])
			})
	)
	for (const operation of [
		'write',
		'readPrior',
		'readWaiting',
		'reserveManualRun',
	] as const)
		test.effect(
			`${operation} propagates review-list errors before any writes`,
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const error = failure(403)
					fixture.fake.failures.listReviews.push(error)
					const call = SummaryReviewService.use(service => {
						if (operation === 'write')
							return service.write(17, draft()).pipe(Effect.asVoid)
						if (operation === 'reserveManualRun')
							return service.reserveManualRun(RESERVE).pipe(Effect.asVoid)
						if (operation === 'readPrior')
							return service.readPrior(17).pipe(Effect.asVoid)
						return service.readWaiting(17).pipe(Effect.asVoid)
					})
					expect(
						yield* call.pipe(Effect.provide(fixture.layer), Effect.flip)
					).toBe(error)
					expect(fixture.fake.writes).toEqual([])
				})
		)
})

layer(APP_MODE_OWNED)('SummaryReviewService identity migration', test => {
	for (const operation of ['write', 'reserve'] as const)
		test.effect(
			`${operation} creates over another owned identity's newest summary`,
			() =>
				Effect.gen(function* () {
					const fixture = setup({}, APP_IDENTITY)
					fixture.fake.reviews.push(
						summaryReview({
							...SUMMARY_MARKER,
							manualRuns: 2,
							needsOwner: ['waiting'],
						})
					)
					if (operation === 'write')
						expect(
							yield* SummaryReviewService.use(service =>
								service.write(17, draft())
							).pipe(Effect.provide(fixture.layer))
						).toMatchObject({
							created: true,
							marker: { runs: 2, manualRuns: 2, needsOwner: ['waiting'] },
						})
					else
						expect(
							yield* SummaryReviewService.use(service =>
								service.reserveManualRun(RESERVE)
							).pipe(Effect.provide(fixture.layer))
						).toBe(true)
					expect(fixture.fake.writes.map(write => write.method)).toEqual(
						operation === 'write' ? ['review', 'minimize'] : ['review']
					)
					expect(
						parseSummaryMarker(fixture.fake.reviews.at(-1)?.body ?? '')
							?.manualRuns
					).toBe(operation === 'write' ? 2 : 3)
				})
		)
})

layer(APP_MODE_OWNED)('SummaryReviewService legacy reservations', test => {
	test.effect(
		'another identity legacy comment is carried into a status review without cleanup',
		() =>
			Effect.gen(function* () {
				const fixture = setup({}, APP_IDENTITY)
				fixture.fake.comments.push(
					appSummary(
						{ ...SUMMARY_MARKER, manualRuns: 2, needsOwner: ['waiting'] },
						{
							author: {
								__typename: 'Bot',
								login: GITHUB_ACTIONS_IDENTITY.login,
							},
						}
					)
				)
				expect(
					yield* SummaryReviewService.use(service =>
						service.reserveManualRun(RESERVE)
					).pipe(Effect.provide(fixture.layer))
				).toBe(true)
				expect(fixture.fake.writes.map(write => write.method)).toEqual([
					'review',
				])
				expect(fixture.fake.comments[0]?.isMinimized).toBe(false)
				expect(parseSummaryMarker(fixture.fake.reviews[0]?.body ?? '')).toEqual(
					{ ...SUMMARY_MARKER, manualRuns: 3, needsOwner: ['waiting'] }
				)
			})
	)
})

layer(TOKEN_MODE_OWNED)('Summary review status sweep', test => {
	for (const waiting of [false, true])
		test.effect(
			`a hidden dismissed summary overrides duplicate legacy summaries and retains waiting=${waiting}`,
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.reviews.push(
						summaryReview(
							{
								...SUMMARY_MARKER,
								finished: true,
								...(waiting ? { needsOwner: ['waiting'] } : {}),
							},
							{ isMinimized: true, state: 'DISMISSED' }
						)
					)
					fixture.fake.comments.push(
						...[201, 202].map(databaseId =>
							appSummary(
								{ ...SUMMARY_MARKER, finished: false },
								{
									databaseId,
									author: {
										__typename: 'Bot',
										login: GITHUB_ACTIONS_IDENTITY.login,
									},
								}
							)
						)
					)
					const statuses = githubStatusFake({
						listOpenPullRequests: () =>
							Effect.succeed([openPullRequest(17, 'head')]),
						getStatus: () =>
							Effect.succeed({
								id: 1,
								context: 'MNG Review',
								creator: null,
								state: 'error',
								description: 'stale',
							}),
					})
					expect(
						yield* StatusSweepService.use(service => service.sweep()).pipe(
							Effect.provide(
								StatusSweepServiceLive.pipe(
									Layer.provide(Layer.merge(fixture.fake.api, statuses.layer))
								)
							)
						)
					).toEqual({
						checked: 1,
						updated: 1,
						failed: 0,
						dismissal: NO_DISMISSAL,
					})
					expect(statuses.statuses).toEqual([
						{
							sha: 'head',
							...toCommitStatus(waiting ? 'needs owner' : 'ready', 0, true),
						},
					])
					expect(fixture.fake.writes).toEqual([])
					expect(fixture.fake.reviewReads).toEqual([17])
				})
		)
})
