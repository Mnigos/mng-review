import { layer } from '@effect/vitest'
import {
	parseRiskDescription,
	toRiskDescription,
	toRulesDigest,
} from '@mng-review/domain'
import { Effect } from 'effect'
import {
	GITHUB_ACTIONS_IDENTITY,
	type BotIdentity,
} from '../../../platform/bot-identity.helper'
import { GitHubApiError } from '../../../platform/github.errors'
import {
	confirmedThread,
	PREVIOUS_APP_IDENTITY,
	riskFixture,
	riskInput,
	riskStatus,
	RISK_HEAD,
	SWITCHED_APP_OWNED,
	RISK_BASE,
	RISK_TREE,
	RISK_DESCRIPTION,
	LOW_RATING,
} from '../../../shared/mocks/github-status-fake.helper'
import {
	APP_MODE_OWNED,
	APP_IDENTITY,
	appSummary,
	summaryReview,
	SUMMARY_MARKER,
	botThread,
} from '../../../shared/mocks/publish-test.helper'
import { parseRiskMarker } from '../../publish/domain/publish-marker.parser'
import { MARKER_VERSION } from '../../publish/domain/publish.constants'
import { toMarkerComment } from '../../publish/presentation/thread-comment.formatter'
import { EMPTY_RISK_MARKER } from '../domain/risk-marker.helper'
import { RiskReadService } from './risk-read.service'
import { RiskStartService } from './risk-start.service'

/** A still-found answer of the token app that could not reopen its thread after it posted. */
function unsettledAnswer() {
	return {
		databaseId: 7,
		body: toMarkerComment('reply', {
			v: MARKER_VERSION,
			action: 'still-found',
			commit: RISK_HEAD,
			reply: 6,
			unsettled: true,
		}),
		author: { __typename: 'Bot', login: APP_IDENTITY.login },
		editor: null,
		originalCommit: null,
	}
}

layer(APP_MODE_OWNED)('risk held read and step one', test => {
	test.effect(
		'reads statuses from commits and both force-push sides, including error levels',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const before = 'd'.repeat(40)
				const after = 'e'.repeat(40)
				fake.items.push(
					{ __typename: 'PullRequestCommit', commit: { oid: 'old' } },
					{
						__typename: 'HeadRefForcePushedEvent',
						beforeCommit: { oid: before },
						afterCommit: { oid: after },
					}
				)
				fake.statuses.set(before, [riskStatus({}, { level: 'high' })])
				fake.statuses.set(RISK_HEAD, [
					riskStatus({ id: 9 }, { pr: 18, level: 'high' }),
				])
				const held = yield* RiskReadService.use(service =>
					service.readHeld(17, RISK_HEAD)
				).pipe(Effect.provide(fake.readLayer))
				expect(held.held).toBe('high')
				expect(new Set(held.heads)).toEqual(
					new Set([RISK_HEAD, 'old', before, after])
				)
				expect(fake.reads).toEqual(
					expect.arrayContaining([RISK_HEAD, 'old', before, after])
				)
				expect(fake.writes).toEqual([])
			})
	)
	test.effect(
		'a 404 on a timeline head statuses fails the held read before any write',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				fake.items.push({
					__typename: 'PullRequestCommit',
					commit: { oid: 'd'.repeat(40) },
				})
				fake.failures.statuses.push(
					undefined,
					new GitHubApiError({
						operation: 'read',
						reason: 'not found',
						status: 404,
					})
				)
				expect(
					yield* RiskStartService.use(service =>
						service.startFull(riskInput())
					).pipe(Effect.provide(fake.services), Effect.flip)
				).toMatchObject({ _tag: 'RiskStepOneError', stage: 'held-read' })
				expect(fake.writes).toEqual([])
				expect(fake.api.writes).toEqual([])
			})
	)
	for (const failure of ['timeline', 'statuses'] as const)
		test.effect(
			`${failure} failure stops with RiskStepOneError before any write`,
			() =>
				Effect.gen(function* () {
					const fake = riskFixture()
					fake.failures[failure].push(
						new GitHubApiError({
							operation: 'read',
							reason: 'unavailable',
							status: 503,
						})
					)
					expect(
						yield* RiskStartService.use(service =>
							service.startFull(riskInput())
						).pipe(Effect.provide(fake.services), Effect.flip)
					).toMatchObject({ _tag: 'RiskStepOneError', stage: 'held-read' })
					expect(fake.writes).toEqual([])
					expect(fake.api.writes).toEqual([])
				})
		)
	test.effect(
		'writes the step-one maximum, real merge base, rules digest and random nonce before the empty marker',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				fake.gitState.base = 'f'.repeat(40)
				const input = riskInput()
				const run = yield* RiskStartService.use(service =>
					service.startFull(input)
				).pipe(Effect.provide(fake.services))
				expect(fake.writes).toHaveLength(1)
				expect(fake.writes[0]).toMatchObject({
					state: 'error',
					sha: RISK_HEAD,
					apiWritesBefore: 0,
				})
				expect(
					parseRiskDescription(fake.writes[0]?.description ?? '')
				).toMatchObject({
					pr: 17,
					level: 'low',
					base: fake.gitState.base,
					rules: toRulesDigest(
						input.rules.risk?.rubric ?? '',
						input.rules.config.risk
					),
				})
				expect(run.description.nonce).toMatch(/^[0-9a-f]{16}$/u)
				expect(fake.api.writes).toMatchObject([{ method: 'create' }])
				expect(parseRiskMarker(fake.api.comments[0]?.body ?? '')).toEqual(
					EMPTY_RISK_MARKER
				)
				expect(run.decision.status).toBe('rated')
			})
	)
	test.effect(
		'a High held error raises step one even when the model returns Low',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				fake.statuses.set(RISK_HEAD, [riskStatus({}, { level: 'high' })])
				expect(
					(yield* RiskStartService.use(service =>
						service.startFull(riskInput())
					).pipe(Effect.provide(fake.services))).description.level
				).toBe('high')
			})
	)
	test.effect('a failed status create writes no marker', () =>
		Effect.gen(function* () {
			const fake = riskFixture()
			fake.failures.create.push(
				new GitHubApiError({ operation: 'create', reason: 'refused' })
			)
			expect(
				yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services), Effect.flip)
			).toMatchObject({ _tag: 'RiskStepOneError', stage: 'status-create' })
			expect(fake.api.writes).toEqual([])
		})
	)
	for (const readback of ['lost nonce', 'failed read'] as const)
		test.effect(
			`step one ${readback} fails the job and creates no marker`,
			() =>
				Effect.gen(function* () {
					const fake = riskFixture()
					if (readback === 'lost nonce')
						fake.statusSnapshots.push(undefined, [riskStatus({ id: 99 })])
					else
						fake.failures.statuses.push(
							undefined,
							new GitHubApiError({ operation: 'read', reason: 'unavailable' })
						)
					expect(
						yield* RiskStartService.use(service =>
							service.startFull(riskInput())
						).pipe(Effect.provide(fake.services), Effect.flip)
					).toMatchObject({ _tag: 'RiskStepOneError', stage: 'read-back' })
					expect(fake.writes).toHaveLength(1)
					expect(fake.api.writes).toEqual([])
				})
		)
	test.effect(
		'another pull request with a newer status on the same head cannot steal the nonce',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const input = riskInput()
				const run = yield* RiskStartService.use(service =>
					service.startFull(input)
				).pipe(Effect.provide(fake.services))
				fake.statuses
					.get(RISK_HEAD)
					?.unshift(riskStatus({ id: 999 }, { pr: 18, nonce: 'f'.repeat(16) }))
				expect(
					(yield* RiskReadService.use(service =>
						service.readHeadStatuses(17, RISK_HEAD)
					).pipe(Effect.provide(fake.readLayer)))[0]?.description.nonce
				).toBe(run.description.nonce)
			})
	)
	test.effect(
		'records an edited marker higher level before rebuilding from grants only and leaves the run unrated',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				fake.statuses.set(RISK_HEAD, [riskStatus({ state: 'success' })])
				fake.api.comments.push(
					appSummary(undefined, {
						body: toMarkerComment('risk', {
							...EMPTY_RISK_MARKER,
							highest: 'high',
							heads: [
								{
									head: 'f'.repeat(40),
									tree: RISK_TREE,
									base: RISK_BASE,
									rules: RISK_DESCRIPTION.rules,
									level: 'high',
								},
							],
						}),
						editor: { __typename: 'User', login: 'writer' },
					})
				)
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				expect(run.decision).toMatchObject({
					status: 'unrated',
					reason: 'marker-edited',
					stepOne: 'high',
				})
				expect(
					parseRiskDescription(fake.writes[0]?.description ?? '')?.level
				).toBe('high')
				expect(fake.writes[0]?.apiWritesBefore).toBe(0)
				expect(parseRiskMarker(fake.api.comments[0]?.body ?? '')).toEqual({
					v: 1,
					highest: 'high',
					heads: [
						{
							head: RISK_HEAD,
							tree: RISK_TREE,
							base: RISK_BASE,
							rules: RISK_DESCRIPTION.rules,
							level: 'low',
						},
					],
				})
			})
	)
	for (const history of ['success', 'failure', 'review'] as const)
		test.effect(
			`a missing marker with ${history} history stays unrated without recreating it`,
			() =>
				Effect.gen(function* () {
					const fake = riskFixture()
					if (history === 'review')
						fake.api.reviews.push(
							summaryReview(
								{ ...SUMMARY_MARKER, risk: 'low' },
								{ author: { __typename: 'Bot', login: APP_IDENTITY.login } }
							)
						)
					else fake.statuses.set(RISK_HEAD, [riskStatus({ state: history })])
					expect(
						(yield* RiskStartService.use(service =>
							service.startFull(riskInput())
						).pipe(Effect.provide(fake.services))).decision
					).toMatchObject({
						status: 'unrated',
						reason: 'history-without-marker',
					})
					expect(fake.api.writes).toEqual([])
				})
		)
	test.effect(
		'error-only history permits a new empty marker and a rating',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				fake.statuses.set(RISK_HEAD, [riskStatus({}, { level: 'medium' })])
				expect(
					(yield* RiskStartService.use(service =>
						service.startFull(riskInput())
					).pipe(Effect.provide(fake.services))).decision
				).toMatchObject({ status: 'rated', level: 'medium' })
				expect(
					parseRiskMarker(fake.api.comments[0]?.body ?? '')?.heads
				).toEqual([])
			})
	)
	for (const change of ['none', 'rules', 'base'] as const)
		test.effect(
			`same tree, base and rules reuse takes the place of the model level (changed: ${change})`,
			() =>
				Effect.gen(function* () {
					const fake = riskFixture()
					const input = riskInput()
					const digest = toRulesDigest(
						input.rules.risk?.rubric ?? '',
						input.rules.config.risk
					)
					fake.api.comments.push(
						appSummary(undefined, {
							body: toMarkerComment('risk', {
								...EMPTY_RISK_MARKER,
								highest: 'low',
								heads: [
									{
										head: 'f'.repeat(40),
										tree: RISK_TREE,
										base: RISK_BASE,
										rules: change === 'rules' ? 'f'.repeat(12) : digest,
										level: 'medium',
									},
								],
							}),
						})
					)
					if (change === 'base') fake.gitState.base = 'd'.repeat(40)
					const run = yield* RiskStartService.use(service =>
						service.startFull(input)
					).pipe(Effect.provide(fake.services))
					expect(run.decision).toMatchObject({
						status: 'rated',
						level: change === 'none' ? 'medium' : 'low',
					})
					expect(run.block).toMatchObject({ reused: change === 'none' })
				})
		)
	for (const reason of ['coverage-gap', 'rater-failed'] as const)
		test.effect(`same tree and base reuse leaves ${reason} unrated`, () =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const input = riskInput({
					report: {
						...riskInput().report,
						rating: {
							...LOW_RATING,
							status: 'unrated',
							reason,
							detail: 'missing',
						},
					},
				})
				fake.api.comments.push(
					appSummary(undefined, {
						body: toMarkerComment('risk', {
							...EMPTY_RISK_MARKER,
							highest: 'medium',
							heads: [
								{
									head: 'f'.repeat(40),
									tree: RISK_TREE,
									base: RISK_BASE,
									rules: toRulesDigest(
										input.rules.risk?.rubric ?? '',
										input.rules.config.risk
									),
									level: 'medium',
								},
							],
						}),
					})
				)
				expect(
					(yield* RiskStartService.use(service =>
						service.startFull(input)
					).pipe(Effect.provide(fake.services))).decision
				).toMatchObject({ status: 'unrated', reason })
			})
		)
	for (const path of ['.github/workflows/review.yml', 'archive.bin'])
		test.effect(`publish reads its own complete floor diff for ${path}`, () =>
			Effect.gen(function* () {
				const fake = riskFixture()
				fake.gitState.diff = {
					intact: true,
					files: [
						{
							path,
							status: 'M',
							oldMode: '100644',
							newMode: '100644',
							count: path.endsWith('.bin')
								? 'binary'
								: { added: 1, deleted: 0 },
						},
					],
				}
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				expect(fake.reads).toContain(`floors:${RISK_BASE}:${RISK_HEAD}`)
				expect(run.decision).toMatchObject(
					path.endsWith('.bin')
						? { status: 'unrated', reason: 'opaque-binary' }
						: { status: 'rated', level: 'high', floor: true, stepOne: 'high' }
				)
				expect(toRiskDescription(run.description)).toContain(
					path.endsWith('.bin') ? 'floor=-' : 'floor=yes'
				)
			})
		)
	for (const severity of ['high', 'critical'] as const)
		test.effect(
			`a confirmed ${severity} open thread raises a full run and a thread run`,
			() =>
				Effect.gen(function* () {
					const fake = riskFixture()
					const thread = confirmedThread()
					fake.threads.push({
						...thread,
						marker: { ...thread.marker, severity },
					})
					expect(
						(yield* RiskStartService.use(service =>
							service.startFull(riskInput())
						).pipe(Effect.provide(fake.services))).decision
					).toMatchObject({ status: 'rated', level: 'high' })
					const started = yield* RiskStartService.use(service =>
						service.startThread(riskInput())
					).pipe(Effect.provide(fake.services))
					expect(started).toMatchObject({
						status: 'started',
						run: {
							decision: { status: 'rated', level: 'high' },
							tree: undefined,
						},
					})
				})
		)
	test.effect('an unconfirmed High bug thread raises nothing', () =>
		Effect.gen(function* () {
			const fake = riskFixture()
			fake.threads.push(botThread())
			expect(
				yield* RiskStartService.use(service =>
					service.startThread(riskInput())
				).pipe(Effect.provide(fake.services))
			).toEqual({ status: 'none' })
			expect(
				(yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))).decision
			).toMatchObject({ status: 'rated', level: 'low' })
		})
	)
	test.effect(
		'a resolved confirmed High thread raises only when the run answered it without closing it',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				fake.threads.push(confirmedThread({ id: 'kept', resolved: true }))
				expect(
					yield* RiskStartService.use(service =>
						service.startThread(riskInput())
					).pipe(Effect.provide(fake.services))
				).toEqual({ status: 'none' })
				expect(
					yield* RiskStartService.use(service =>
						service.startThread({ ...riskInput(), answered: ['kept'] })
					).pipe(Effect.provide(fake.services))
				).toMatchObject({
					status: 'started',
					run: { decision: { status: 'rated', level: 'high' } },
				})
			})
	)
	test.effect(
		'a resolved confirmed High thread whose newest app answer is unsettled raises every rating',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				fake.threads.push(
					confirmedThread({ id: 'kept', resolved: true, unsettled: true })
				)
				expect(
					(yield* RiskStartService.use(service =>
						service.startFull(riskInput())
					).pipe(Effect.provide(fake.services))).decision
				).toMatchObject({ status: 'rated', level: 'high' })
				expect(
					yield* RiskStartService.use(service =>
						service.startThread(riskInput())
					).pipe(Effect.provide(fake.services))
				).toMatchObject({
					status: 'started',
					run: { decision: { status: 'rated', level: 'high' } },
				})
			})
	)
	test.effect(
		'a resolved confirmed thread its window cannot tell about is read whole',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				fake.threads.push(
					confirmedThread({ id: 'long', resolved: true, unsettled: undefined })
				)
				fake.api.threadComments.set('long', [unsettledAnswer()])
				expect(
					yield* RiskStartService.use(service =>
						service.startThread(riskInput())
					).pipe(Effect.provide(fake.services))
				).toMatchObject({
					status: 'started',
					run: { decision: { status: 'rated', level: 'high' } },
				})
				fake.api.failures.listThreadComments.push(
					new GitHubApiError({ operation: 'read', reason: 'unavailable' })
				)
				expect(
					(yield* RiskStartService.use(service =>
						service.startFull(riskInput())
					).pipe(Effect.provide(fake.services))).decision
				).toMatchObject({ status: 'unrated' })
			})
	)
	test.effect('a thread run with nothing to raise writes nothing', () =>
		Effect.gen(function* () {
			const fake = riskFixture()
			expect(
				yield* RiskStartService.use(service =>
					service.startThread(riskInput())
				).pipe(Effect.provide(fake.services))
			).toEqual({ status: 'none' })
			expect(fake.writes).toEqual([])
			expect(fake.api.writes).toEqual([])
		})
	)
})

layer(APP_MODE_OWNED)('risk marker creation failure', test => {
	test.effect(
		'a marker that cannot be created cannot publish a rated block',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				fake.api.failures.create.push(
					new GitHubApiError({ operation: 'create', reason: 'unavailable' })
				)
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				expect(run.decision).toMatchObject({
					status: 'unrated',
					reason: 'publish-failed',
				})
				expect(run.block).toMatchObject({
					status: 'unrated',
					reason: 'publish-failed',
				})
			})
	)
})

/** The app's editor entry in an edit history. */
const APP_EDITOR = { __typename: 'Bot', login: APP_IDENTITY.login } as const

/** An edit by a person that left `text`. */
function writerEdit(id: string, text: string) {
	return {
		id,
		editor: { __typename: 'User', login: 'writer' },
		editedAt: '2026-01-01T00:01:00Z',
		diff: text,
	}
}

/** A complete edit history of the risk comment whose text is `body`. */
function rebuildEdits(
	body: string,
	edits: readonly ReturnType<typeof writerEdit>[]
) {
	return { body, total: edits.length, edits }
}

/** An edited risk comment whose text names `level`. */
function editedMarker(level: 'medium' | 'high') {
	return appSummary(undefined, {
		body: toMarkerComment('risk', { ...EMPTY_RISK_MARKER, highest: level }),
		editor: { __typename: 'User', login: 'writer' },
	})
}

layer(APP_MODE_OWNED)('risk marker rebuild after a later edit', test => {
	test.effect(
		'an edit made after step one read the marker is not overwritten by the rebuild',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				fake.api.comments.push(editedMarker('medium'))
				fake.editSnapshots.push(
					rebuildEdits(editedMarker('high').body, [
						writerEdit('edit-1', editedMarker('high').body),
						writerEdit('edit-0', editedMarker('medium').body),
					])
				)
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				expect(run.decision).toMatchObject({
					status: 'unrated',
					reason: 'marker-edited',
					stepOne: 'medium',
				})
				expect(fake.api.writes).toEqual([])
			})
	)
	test.effect('an unchanged edited marker is still rebuilt', () =>
		Effect.gen(function* () {
			const fake = riskFixture()
			fake.api.comments.push(editedMarker('medium'))
			yield* RiskStartService.use(service =>
				service.startFull(riskInput())
			).pipe(Effect.provide(fake.services))
			expect(fake.api.writes.map(write => write.method)).toEqual(['update'])
			expect(fake.reads.filter(read => read.startsWith('edits:'))).toHaveLength(
				2
			)
			expect(fake.writes.map(write => write.state)).toEqual(['error'])
		})
	)
	test.effect(
		"a person's edit between the rebuild's read and its update raises step one's level",
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const medium = editedMarker('medium').body
				fake.api.comments.push(editedMarker('medium'))
				fake.editSnapshots.push(
					rebuildEdits(medium, [writerEdit('edit-0', medium)]),
					rebuildEdits('rebuilt', [
						{ ...writerEdit('edit-2', 'rebuilt'), editor: APP_EDITOR },
						writerEdit('edit-1', editedMarker('high').body),
						writerEdit('edit-0', medium),
					])
				)
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				expect(
					fake.writes.map(
						write => parseRiskDescription(write.description)?.level
					)
				).toEqual(['medium', 'high'])
				expect(fake.writes.map(write => write.state)).toEqual([
					'error',
					'error',
				])
				expect(parseRiskDescription(fake.writes[1]?.description ?? '')).toEqual(
					run.description
				)
				expect(run.description.level).toBe('high')
				expect(run.decision).toMatchObject({
					status: 'unrated',
					reason: 'marker-edited',
				})
			})
	)
	test.effect(
		'an edit history that cannot be read after the rebuild raises step one to High',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				fake.api.comments.push(editedMarker('medium'))
				fake.failures.edits.push(
					undefined,
					new GitHubApiError({ operation: 'edits', reason: 'unavailable' })
				)
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				expect(
					fake.writes.map(
						write => parseRiskDescription(write.description)?.level
					)
				).toEqual(['medium', 'high'])
				expect(run.description.level).toBe('high')
			})
	)
	test.effect(
		'an edit history that cannot be read before the rebuild leaves the edited marker',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				fake.api.comments.push(editedMarker('medium'))
				fake.failures.edits.push(
					new GitHubApiError({ operation: 'edits', reason: 'unavailable' })
				)
				yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				expect(fake.api.writes).toEqual([])
				expect(fake.writes.map(write => write.state)).toEqual(['error'])
			})
	)
	test.effect(
		'a raise that cannot be written fails step one so the job fails',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				fake.api.comments.push(editedMarker('medium'))
				fake.failures.edits.push(
					undefined,
					new GitHubApiError({ operation: 'edits', reason: 'unavailable' })
				)
				fake.failures.create.push(
					undefined,
					new GitHubApiError({ operation: 'status', reason: 'unavailable' })
				)
				expect(
					yield* RiskStartService.use(service =>
						service.startFull(riskInput())
					).pipe(Effect.provide(fake.services), Effect.flip)
				).toMatchObject({ _tag: 'RiskStepOneError', stage: 'marker-raise' })
			})
	)
})

const OLD_HEAD = 'd'.repeat(40)

/** A status on the old head that `identity` wrote, as the previous app or the job token would. */
function seedOldHead(
	fake: ReturnType<typeof riskFixture>,
	identity: BotIdentity
) {
	fake.items.unshift({
		__typename: 'PullRequestCommit',
		commit: { oid: OLD_HEAD },
	})
	fake.statuses.set(OLD_HEAD, [
		riskStatus(
			{
				id: 50,
				state: 'failure',
				creator: { login: identity.restLogin, type: 'Bot' },
			},
			{ level: 'high', nonce: 'f'.repeat(16) }
		),
	])
}

layer(SWITCHED_APP_OWNED)('risk held read after an app switch', test => {
	test.effect(
		'a High the previous app granted on an older head holds the new app at High',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				seedOldHead(fake, PREVIOUS_APP_IDENTITY)
				fake.api.comments.push(
					appSummary(undefined, {
						body: toMarkerComment('risk', EMPTY_RISK_MARKER),
					})
				)
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				expect(run.held).toBe('high')
				expect(run.decision).toMatchObject({ status: 'rated', level: 'high' })
				expect(
					parseRiskDescription(fake.writes[0]?.description ?? '')?.level
				).toBe('high')
			})
	)
	test.effect(
		'a rating by the previous app is history, so a missing marker leaves the run unrated',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				seedOldHead(fake, PREVIOUS_APP_IDENTITY)
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				expect(run.decision).toMatchObject({
					status: 'unrated',
					reason: 'history-without-marker',
					stepOne: 'high',
				})
				expect(fake.api.writes).toEqual([])
			})
	)
	test.effect(
		'a High status the job token wrote raises nothing and is no history',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				seedOldHead(fake, GITHUB_ACTIONS_IDENTITY)
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				expect(run.held).toBe('none')
				expect(run.decision).toMatchObject({ status: 'rated', level: 'low' })
				expect(fake.api.writes.map(write => write.method)).toEqual(['create'])
			})
	)
})

layer(APP_MODE_OWNED)('risk held read of an incomplete timeline', test => {
	for (const item of [
		{ __typename: 'PullRequestCommit', commit: null },
		{
			__typename: 'HeadRefForcePushedEvent',
			beforeCommit: null,
			afterCommit: { oid: RISK_HEAD },
		},
	])
		test.effect(
			`a ${item.__typename} without its commit fails before any write`,
			() =>
				Effect.gen(function* () {
					const fake = riskFixture()
					fake.items.unshift(item)
					expect(
						yield* RiskStartService.use(service =>
							service.startFull(riskInput())
						).pipe(Effect.provide(fake.services), Effect.flip)
					).toMatchObject({ _tag: 'RiskStepOneError', stage: 'held-read' })
					expect(fake.writes).toEqual([])
					expect(fake.api.writes).toEqual([])
				})
		)
})
