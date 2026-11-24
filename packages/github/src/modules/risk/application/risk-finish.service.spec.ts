import { layer } from '@effect/vitest'
import {
	ConfigError,
	DEFAULT_RISK_LABELS,
	parseRiskDescription,
} from '@mng-review/domain'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { GitHubApiError } from '../../../platform/github.errors'
import {
	confirmedThread,
	PREVIOUS_APP_IDENTITY,
	SWITCHED_APP_OWNED,
	riskFixture,
	riskInput,
	riskStatus,
	RISK_HEAD,
	RISK_TREE,
	LOW_RATING,
} from '../../../shared/mocks/github-status-fake.helper'
import {
	APP_IDENTITY,
	APP_MODE_OWNED,
	appSummary,
} from '../../../shared/mocks/publish-test.helper'
import { parseRiskMarker } from '../../publish/domain/publish-marker.parser'
import { toMarkerComment } from '../../publish/presentation/thread-comment.formatter'
import { EMPTY_RISK_MARKER } from '../domain/risk-marker.helper'
import { EDIT_LAG_RETRIES } from '../domain/risk.constants'
import { formatRiskComment } from '../presentation/rating-block.formatter'
import { RiskFinishService } from './risk-finish.service'
import { RiskReadService } from './risk-read.service'
import { RiskStartService } from './risk-start.service'

layer(APP_MODE_OWNED)('risk finish and revocation', test => {
	for (const level of ['low', 'medium', 'high'] as const)
		test.effect(
			`${level} grants last with the same number, nonce and maximum`,
			() =>
				Effect.gen(function* () {
					const fake = riskFixture()
					const run = yield* RiskStartService.use(service =>
						service.startFull(
							riskInput({
								report: {
									...riskInput().report,
									rating: { ...LOW_RATING, level, model: level },
								},
							})
						)
					).pipe(Effect.provide(fake.services))
					const finished = yield* RiskFinishService.use(service =>
						service.finish(run)
					).pipe(Effect.provide(fake.services))
					expect(finished).toMatchObject({
						state: level === 'high' ? 'failure' : 'success',
						level,
					})
					expect(fake.writes.map(write => write.state)).toEqual([
						'error',
						level === 'high' ? 'failure' : 'success',
					])
					expect(
						parseRiskDescription(fake.writes[1]?.description ?? '')
					).toEqual(run.description)
					expect(fake.writes[0]?.apiWritesBefore).toBe(0)
					expect(fake.writes[1]?.apiWritesBefore).toBe(fake.api.writes.length)
					expect(fake.api.writes.map(write => write.method)).toEqual([
						'create',
						'update',
						'label',
					])
					expect(fake.api.writes.at(-1)).toMatchObject({
						method: 'label',
						name: DEFAULT_RISK_LABELS[level],
					})
				})
		)
	for (const stop of [
		'head-moved',
		'marker-edited',
		'held-raised',
		'marker-write',
		'grant-write',
	] as const)
		test.effect(`${stop} leaves error and removes the bot label`, () =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				const pr = fake.api.command.pullRequest
				fake.api.command.pullRequest = {
					...pr,
					labels: [{ name: DEFAULT_RISK_LABELS.low }, { name: 'Blocked' }],
				}
				if (stop === 'head-moved')
					fake.api.pullRequestSnapshots.push(
						fake.api.command.pullRequest,
						fake.api.command.pullRequest,
						{
							...pr,
							head: { ...pr.head, sha: 'f'.repeat(40) },
						}
					)
				if (stop === 'marker-edited')
					fake.api.commentSnapshots.push([
						appSummary(undefined, {
							body: toMarkerComment('risk', EMPTY_RISK_MARKER),
							editor: { __typename: 'User', login: 'writer' },
						}),
					])
				if (stop === 'held-raised')
					fake.statuses
						.get(RISK_HEAD)
						?.push(riskStatus({ id: 0 }, { level: 'high' }))
				if (stop === 'marker-write')
					fake.api.failures.update.push(
						new GitHubApiError({ operation: 'update', reason: 'unavailable' })
					)
				if (stop === 'grant-write')
					fake.failures.create.push(
						new GitHubApiError({ operation: 'create', reason: 'unavailable' })
					)
				const finished = yield* RiskFinishService.use(service =>
					service.finish(run)
				).pipe(Effect.provide(fake.services))
				expect(finished).toMatchObject({
					state: 'error',
					reason:
						stop === 'held-raised' ||
						stop === 'marker-write' ||
						stop === 'grant-write'
							? 'publish-failed'
							: stop,
				})
				expect(fake.api.writes).toContainEqual({
					method: 'unlabel',
					pullNumber: 17,
					name: DEFAULT_RISK_LABELS.low,
				})
				expect(fake.api.writes).not.toContainEqual(
					expect.objectContaining({ name: 'Blocked' })
				)
				expect(fake.statuses.get(RISK_HEAD)?.[0]?.state).toBe('error')
			})
		)
	test.effect(
		'a nonce lost before the grant leaves the newer run its label and status',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				fake.api.command.pullRequest = {
					...fake.api.command.pullRequest,
					labels: [{ name: DEFAULT_RISK_LABELS.low }],
				}
				fake.statuses
					.get(RISK_HEAD)
					?.unshift(
						riskStatus({ id: 999 }, { level: 'low', nonce: 'f'.repeat(16) })
					)
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({ state: 'none', reason: 'nonce-lost' })
				expect(
					fake.api.writes.filter(
						write => write.method === 'label' || write.method === 'unlabel'
					)
				).toEqual([])
				expect(fake.writes.map(write => write.state)).toEqual(['error'])
			})
	)
	test.effect(
		'a nonce lost after the grant leaves the newer run its label',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				fake.api.command.pullRequest = {
					...fake.api.command.pullRequest,
					labels: [{ name: DEFAULT_RISK_LABELS.low }],
				}
				const newer = riskStatus(
					{ id: 999, state: 'success' },
					{ level: 'medium', nonce: 'f'.repeat(16) }
				)
				// The two nonce checks around the marker update read the head's statuses first.
				fake.statusSnapshots.push(undefined, undefined, undefined, [
					newer,
					...(fake.statuses.get(RISK_HEAD) ?? []),
				])
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({ state: 'none', reason: 'nonce-lost' })
				expect(
					fake.api.writes.filter(write => write.method === 'unlabel')
				).toEqual([])
				expect(fake.writes.map(write => write.state)).toEqual([
					'error',
					'success',
				])
			})
	)
	test.effect(
		'a newer other-pull status cannot revoke this pull grant or raise its held level',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				fake.statuses
					.get(RISK_HEAD)
					?.unshift(
						riskStatus(
							{ id: 999 },
							{ pr: 18, level: 'high', nonce: 'f'.repeat(16) }
						)
					)
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({ state: 'success', level: 'low' })
			})
	)
	test.effect(
		'revocation repeats High step one verbatim and holds High on the next head',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(
						riskInput({
							report: {
								...riskInput().report,
								rating: { ...LOW_RATING, level: 'high', model: 'high' },
							},
						})
					)
				).pipe(Effect.provide(fake.services))
				fake.api.command.pullRequest = {
					...fake.api.command.pullRequest,
					labels: [{ name: DEFAULT_RISK_LABELS.high }],
				}
				expect(
					yield* RiskFinishService.use(service => service.revoke(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({
					state: 'error',
					level: 'high',
					reason: 'publish-failed',
				})
				expect(fake.writes[1]?.description).toBe(fake.writes[0]?.description)
				expect(fake.writes.map(write => write.state)).toEqual([
					'error',
					'error',
				])
				expect(fake.api.writes.at(-1)).toMatchObject({
					method: 'unlabel',
					name: DEFAULT_RISK_LABELS.high,
				})
				const next = 'f'.repeat(40)
				fake.items.push({
					__typename: 'HeadRefForcePushedEvent',
					beforeCommit: { oid: RISK_HEAD },
					afterCommit: { oid: next },
				})
				expect(
					(yield* RiskReadService.use(service =>
						service.readHeld(17, next)
					).pipe(Effect.provide(fake.readLayer))).held
				).toBe('high')
				expect(
					(yield* RiskStartService.use(service =>
						service.startFull(riskInput({ head: next }))
					).pipe(Effect.provide(fake.services))).decision
				).toMatchObject({ status: 'rated', level: 'high' })
			})
	)
	test.effect(
		'a thread raise follows the same write order and grants failure without a rated head entry',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				fake.threads.push(confirmedThread())
				const started = yield* RiskStartService.use(service =>
					service.startThread(riskInput())
				).pipe(Effect.provide(fake.services))
				expect(started.status).toBe('started')
				if (started.status === 'none')
					return yield* Effect.die('expected a High thread raise')
				expect(
					yield* RiskFinishService.use(service =>
						service.finish(started.run)
					).pipe(Effect.provide(fake.services))
				).toMatchObject({ state: 'failure', level: 'high' })
				expect(fake.writes.map(write => write.state)).toEqual([
					'error',
					'failure',
				])
				expect(
					parseRiskDescription(fake.writes[0]?.description ?? '')?.level
				).toBe('high')
				expect(parseRiskMarker(fake.api.comments[0]?.body ?? '')).toEqual({
					v: 1,
					highest: 'high',
					heads: [],
				})
				expect(fake.writes.at(-1)?.apiWritesBefore).toBe(fake.api.writes.length)
				return undefined
			})
	)
	test.effect(
		'cleanup before step one removes a bot label without writing a status',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				fake.api.command.pullRequest = {
					...fake.api.command.pullRequest,
					labels: [
						{ name: DEFAULT_RISK_LABELS.low },
						{ name: DEFAULT_RISK_LABELS.high },
					],
				}
				fake.items.push({
					__typename: 'LabeledEvent',
					label: { name: DEFAULT_RISK_LABELS.high },
					actor: { __typename: 'User', login: 'writer' },
				})
				expect(
					yield* RiskFinishService.use(service =>
						service.revokeHead({
							pullNumber: 17,
							head: RISK_HEAD,
							labels: DEFAULT_RISK_LABELS,
						})
					).pipe(Effect.provide(fake.services))
				).toMatchObject({ state: 'none' })
				expect(fake.writes).toEqual([])
				expect(fake.api.writes).toEqual([
					{ method: 'unlabel', pullNumber: 17, name: DEFAULT_RISK_LABELS.low },
				])
			})
	)
})

layer(APP_MODE_OWNED)('risk labels changed during publishing', test => {
	test.effect(
		'a person label added between the label read and the timeline read stops the label step',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				const before = fake.api.command.pullRequest
				fake.items.push({
					__typename: 'LabeledEvent',
					actor: { __typename: 'User', login: 'writer' },
					label: { name: DEFAULT_RISK_LABELS.high },
				})
				fake.api.command.pullRequest = {
					...before,
					labels: [{ name: DEFAULT_RISK_LABELS.high }],
				}
				fake.api.pullRequestSnapshots.push(before)
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({ state: 'error', reason: 'publish-failed' })
				expect(
					fake.api.writes.filter(
						write => write.method === 'label' || write.method === 'unlabel'
					)
				).toEqual([])
				expect(fake.writes.map(write => write.state)).toEqual(['error'])
			})
	)
	test.effect(
		'a bot label a person removes and adds again after the first timeline read stays',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const high = { name: DEFAULT_RISK_LABELS.high }
				fake.items.push({
					__typename: 'LabeledEvent',
					actor: { __typename: 'Bot', login: APP_IDENTITY.login },
					label: high,
				})
				fake.api.command.pullRequest = {
					...fake.api.command.pullRequest,
					labels: [high],
				}
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				const writer = { __typename: 'User', login: 'writer' }
				fake.afterTimeline.push(() => {
					fake.items.push(
						{ __typename: 'UnlabeledEvent', actor: writer, label: high },
						{ __typename: 'LabeledEvent', actor: writer, label: high }
					)
				})
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({ state: 'error', reason: 'publish-failed' })
				expect(getLabelWrites(fake)).toEqual([])
				expect(fake.writes.map(write => write.state)).toEqual(['error'])
			})
	)
	test.effect(
		'keeps a higher person label added after step one and adds no lower label',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				fake.items.push({
					__typename: 'LabeledEvent',
					actor: { __typename: 'User', login: 'writer' },
					label: { name: DEFAULT_RISK_LABELS.high },
				})
				fake.api.command.pullRequest = {
					...fake.api.command.pullRequest,
					labels: [{ name: DEFAULT_RISK_LABELS.high }, { name: 'Blocked' }],
				}
				yield* RiskFinishService.use(service => service.finish(run)).pipe(
					Effect.provide(fake.services)
				)
				expect(
					fake.api.writes.filter(
						write => write.method === 'label' || write.method === 'unlabel'
					)
				).toEqual([])
			})
	)
})

layer(APP_MODE_OWNED)('risk labels that cannot be set', test => {
	test.effect(
		'a failed fresh timeline read changes no label and writes no grant',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				fake.api.command.pullRequest = {
					...fake.api.command.pullRequest,
					labels: [{ name: DEFAULT_RISK_LABELS.high }],
				}
				fake.failures.timeline.push(
					new GitHubApiError({ operation: 'timeline', reason: 'unavailable' }),
					new GitHubApiError({ operation: 'timeline', reason: 'unavailable' })
				)
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({
					state: 'error',
					reason: 'publish-failed',
					labelFailed: true,
				})
				expect(
					fake.api.writes.filter(
						write => write.method === 'label' || write.method === 'unlabel'
					)
				).toEqual([])
				expect(fake.writes.map(write => write.state)).toEqual(['error'])
			})
	)
	test.effect(
		'a failed label change writes no grant and the cleanup removes the bot label again',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				const pr = fake.api.command.pullRequest
				const labeled = {
					...pr,
					labels: [{ name: DEFAULT_RISK_LABELS.medium }, { name: 'Blocked' }],
				}
				fake.api.pullRequestSnapshots.push(labeled, labeled, labeled, labeled)
				fake.api.failures.unlabel.push(
					new GitHubApiError({ operation: 'unlabel', reason: 'unavailable' })
				)
				fake.api.failures.label.push(
					new GitHubApiError({ operation: 'label', reason: 'unavailable' })
				)
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({ state: 'error', reason: 'publish-failed' })
				expect(getLabelWrites(fake)).toEqual([
					{
						method: 'unlabel',
						pullNumber: 17,
						name: DEFAULT_RISK_LABELS.medium,
					},
					{ method: 'label', pullNumber: 17, name: DEFAULT_RISK_LABELS.low },
					{
						method: 'unlabel',
						pullNumber: 17,
						name: DEFAULT_RISK_LABELS.medium,
					},
				])
				expect(fake.writes.map(write => write.state)).toEqual(['error'])
			})
	)
})

/** The label writes the fake API recorded. */
function getLabelWrites(fake: ReturnType<typeof riskFixture>) {
	return fake.api.writes.filter(
		write => write.method === 'label' || write.method === 'unlabel'
	)
}

const OTHER_HEAD = 'f'.repeat(40)
const OTHER_NONCE = 'f'.repeat(16)

layer(APP_MODE_OWNED)('risk grant re-checks', test => {
	test.effect(
		'a merge base that moved on the same base branch stops the grant',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				const pr = fake.api.command.pullRequest
				fake.api.command.pullRequest = {
					...pr,
					base: { ...pr.base, sha: OTHER_HEAD },
				}
				fake.gitState.base = 'e'.repeat(40)
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({ state: 'error', reason: 'head-moved' })
				expect(fake.api.command.pullRequest.base.ref).toBe(pr.base.ref)
				expect(fake.reads).toContain(`mergeBase:${OTHER_HEAD}:${RISK_HEAD}`)
				expect(fake.writes.map(write => write.state)).toEqual(['error'])
			})
	)
	test.effect('a merge base that cannot be read again stops the grant', () =>
		Effect.gen(function* () {
			const fake = riskFixture()
			const run = yield* RiskStartService.use(service =>
				service.startFull(riskInput())
			).pipe(Effect.provide(fake.services))
			const pr = fake.api.command.pullRequest
			fake.api.command.pullRequest = {
				...pr,
				base: { ...pr.base, sha: OTHER_HEAD },
			}
			fake.failures.mergeBase.push(
				new ConfigError({ source: 'git', reason: 'missing object' })
			)
			expect(
				yield* RiskFinishService.use(service => service.finish(run)).pipe(
					Effect.provide(fake.services)
				)
			).toMatchObject({ state: 'error', reason: 'head-moved' })
			expect(fake.writes.map(write => write.state)).toEqual(['error'])
		})
	)
	test.effect(
		'a base branch that only advanced keeps the merge base and grants',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				const pr = fake.api.command.pullRequest
				fake.api.command.pullRequest = {
					...pr,
					base: { ...pr.base, sha: OTHER_HEAD },
				}
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({ state: 'success', level: 'low' })
				expect(fake.reads).toContain(`mergeBase:${OTHER_HEAD}:${RISK_HEAD}`)
			})
	)
	test.effect(
		'a High error on another head written during the run stops the grant',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				fake.items.push(
					{
						__typename: 'HeadRefForcePushedEvent',
						beforeCommit: { oid: RISK_HEAD },
						afterCommit: { oid: OTHER_HEAD },
					},
					{
						__typename: 'HeadRefForcePushedEvent',
						beforeCommit: { oid: OTHER_HEAD },
						afterCommit: { oid: RISK_HEAD },
					}
				)
				fake.statuses.set(OTHER_HEAD, [
					riskStatus({ id: 500 }, { level: 'high', nonce: OTHER_NONCE }),
				])
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({ state: 'error', reason: 'publish-failed' })
				expect(fake.writes.map(write => write.state)).toEqual(['error'])
			})
	)
	test.effect('a failed held read before the grant stops it', () =>
		Effect.gen(function* () {
			const fake = riskFixture()
			const run = yield* RiskStartService.use(service =>
				service.startFull(riskInput())
			).pipe(Effect.provide(fake.services))
			fake.failures.statuses.push(
				undefined,
				undefined,
				new GitHubApiError({ operation: 'statuses', reason: 'unavailable' })
			)
			expect(
				yield* RiskFinishService.use(service => service.finish(run)).pipe(
					Effect.provide(fake.services)
				)
			).toMatchObject({
				state: 'error',
				reason: 'publish-failed',
				detail: 'the held level could not be read again',
			})
			expect(fake.writes.map(write => write.state)).toEqual(['error'])
		})
	)
	test.effect(
		'a failed held read after the grant revokes it with step one',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				fake.failures.statuses.push(
					undefined,
					undefined,
					undefined,
					new GitHubApiError({ operation: 'statuses', reason: 'unavailable' })
				)
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({
					state: 'error',
					reason: 'publish-failed',
					detail: 'the grant could not be read back',
				})
				expect(fake.writes.map(write => write.state)).toEqual([
					'error',
					'success',
					'error',
				])
				expect(fake.writes[2]?.description).toBe(fake.writes[0]?.description)
				expect(fake.statuses.get(RISK_HEAD)?.[0]?.state).toBe('error')
			})
	)
	test.effect(
		'a grant whose read-back and revocation both fail fails the job',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				fake.failures.statuses.push(
					undefined,
					undefined,
					undefined,
					new GitHubApiError({ operation: 'statuses', reason: 'unavailable' })
				)
				fake.failures.create.push(
					undefined,
					new GitHubApiError({ operation: 'create', reason: 'unavailable' })
				)
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({
					state: 'error',
					reason: 'publish-failed',
					grantStands: true,
				})
				expect(fake.writes.map(write => write.state)).toEqual([
					'error',
					'success',
					'error',
				])
				expect(fake.statuses.get(RISK_HEAD)?.[0]?.state).toBe('success')
			})
	)
	test.effect(
		'a confirmed High thread reopened after step one stops a Low grant',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				fake.threads.push(confirmedThread({ resolved: true }))
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				expect(run.decision).toMatchObject({ status: 'rated', level: 'low' })
				fake.threads.splice(0, 1, confirmedThread())
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({ state: 'error', reason: 'publish-failed' })
				expect(fake.writes.map(write => write.state)).toEqual(['error'])
			})
	)
	test.effect('threads that cannot be read again stop a Low grant', () =>
		Effect.gen(function* () {
			const fake = riskFixture()
			const run = yield* RiskStartService.use(service =>
				service.startFull(riskInput())
			).pipe(Effect.provide(fake.services))
			fake.failures.threads.push(
				new GitHubApiError({ operation: 'threads', reason: 'unavailable' })
			)
			expect(
				yield* RiskFinishService.use(service => service.finish(run)).pipe(
					Effect.provide(fake.services)
				)
			).toMatchObject({ state: 'error', reason: 'thread-read-failed' })
			expect(fake.writes.map(write => write.state)).toEqual(['error'])
		})
	)
	test.effect('a confirmed High thread that stays resolved keeps Low', () =>
		Effect.gen(function* () {
			const fake = riskFixture()
			fake.threads.push(confirmedThread({ resolved: true }))
			const run = yield* RiskStartService.use(service =>
				service.startFull(riskInput())
			).pipe(Effect.provide(fake.services))
			expect(
				yield* RiskFinishService.use(service => service.finish(run)).pipe(
					Effect.provide(fake.services)
				)
			).toMatchObject({ state: 'success', level: 'low' })
		})
	)
	test.effect(
		'the marker update starts from the current trusted marker, not the snapshot',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				const other = {
					head: OTHER_HEAD,
					tree: RISK_TREE,
					base: 'e'.repeat(40),
					rules: run.description.rules,
					level: 'medium',
				} as const
				const [comment] = fake.api.comments
				if (!comment) return yield* Effect.die('expected the risk comment')
				fake.api.comments[0] = {
					...comment,
					body: formatRiskComment({
						v: 1,
						highest: 'medium',
						heads: [other],
					}),
				}
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({ state: 'success', level: 'low' })
				expect(parseRiskMarker(fake.api.comments[0]?.body ?? '')).toMatchObject(
					{
						highest: 'medium',
						heads: [other, { head: RISK_HEAD, level: 'low' }],
					}
				)
				return undefined
			})
	)
	test.effect('a marker a person edited after step one is never replaced', () =>
		Effect.gen(function* () {
			const fake = riskFixture()
			const run = yield* RiskStartService.use(service =>
				service.startFull(riskInput())
			).pipe(Effect.provide(fake.services))
			const [comment] = fake.api.comments
			if (!comment) return yield* Effect.die('expected the risk comment')
			const edited = {
				...comment,
				body: formatRiskComment({ v: 1, highest: 'high', heads: [] }),
				editor: { __typename: 'User', login: 'writer' },
			}
			fake.api.comments[0] = edited
			const updates = fake.api.writes.filter(
				write => write.method === 'update'
			).length
			expect(
				yield* RiskFinishService.use(service => service.finish(run)).pipe(
					Effect.provide(fake.services)
				)
			).toMatchObject({ state: 'error', reason: 'marker-edited' })
			expect(
				fake.api.writes.filter(write => write.method === 'update')
			).toHaveLength(updates)
			expect(fake.api.comments[0]).toEqual(edited)
			expect(fake.writes.map(write => write.state)).toEqual(['error'])
			return undefined
		})
	)
	test.effect(
		'a grant GitHub stored whose answer was lost is reported as written',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				fake.failures.createStored.push(
					new GitHubApiError({ operation: 'create', reason: 'timeout' })
				)
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({ state: 'success', level: 'low' })
				expect(fake.writes.map(write => write.state)).toEqual([
					'error',
					'success',
				])
				expect(getLabelWrites(fake)).toEqual([
					{ method: 'label', pullNumber: 17, name: DEFAULT_RISK_LABELS.low },
				])
			})
	)
	test.effect(
		'a grant write that cannot be confirmed is revoked with step one',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				fake.failures.createStored.push(
					new GitHubApiError({ operation: 'create', reason: 'timeout' })
				)
				fake.failures.statuses.push(
					undefined,
					undefined,
					undefined,
					new GitHubApiError({ operation: 'statuses', reason: 'unavailable' })
				)
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({ state: 'error', reason: 'publish-failed' })
				expect(fake.writes.map(write => write.state)).toEqual([
					'error',
					'success',
					'error',
				])
				expect(fake.writes[2]?.description).toBe(fake.writes[0]?.description)
				expect(fake.statuses.get(RISK_HEAD)?.[0]?.state).toBe('error')
			})
	)
	test.effect(
		'a higher error that lands just before the grant revokes the grant',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				fake.beforeCreate.push(() => {
					fake.statuses.set(RISK_HEAD, [
						riskStatus({ id: 900 }, { level: 'high', nonce: OTHER_NONCE }),
						...(fake.statuses.get(RISK_HEAD) ?? []),
					])
				})
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({ state: 'error', reason: 'publish-failed' })
				expect(fake.writes.map(write => write.state)).toEqual([
					'error',
					'success',
					'error',
				])
				expect(fake.writes[2]?.description).toBe(fake.writes[0]?.description)
				expect(fake.statuses.get(RISK_HEAD)?.[0]?.state).toBe('error')
			})
	)
	test.effect(
		'cleanup never revokes a newer run status with this run description',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				fake.statuses.set(RISK_HEAD, [
					riskStatus(
						{ id: 999, state: 'success' },
						{ level: 'medium', nonce: OTHER_NONCE }
					),
					...(fake.statuses.get(RISK_HEAD) ?? []),
				])
				fake.api.command.pullRequest = {
					...fake.api.command.pullRequest,
					labels: [{ name: DEFAULT_RISK_LABELS.medium }],
				}
				expect(
					yield* RiskFinishService.use(service => service.revoke(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({ state: 'none' })
				expect(fake.writes.map(write => write.state)).toEqual(['error'])
				expect(getLabelWrites(fake)).toEqual([])
			})
	)
	test.effect(
		'cleanup that cannot read the newest status writes an error that never lowers the held level',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				fake.failures.statuses.push(
					new GitHubApiError({ operation: 'statuses', reason: 'unavailable' })
				)
				expect(
					yield* RiskFinishService.use(service => service.revoke(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({ state: 'error', level: 'low' })
				expect(fake.writes.map(write => write.state)).toEqual([
					'error',
					'error',
				])
				expect(fake.writes[1]?.description).toBe(fake.writes[0]?.description)
			})
	)
})

layer(APP_MODE_OWNED)('risk labels whose setter is unknown', test => {
	test.effect(
		'a timeline without the head changes no label and writes no grant',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				fake.items.splice(0, fake.items.length, {
					__typename: 'LabeledEvent',
					label: { name: DEFAULT_RISK_LABELS.high },
					actor: { __typename: 'User', login: 'writer' },
				})
				fake.api.command.pullRequest = {
					...fake.api.command.pullRequest,
					labels: [{ name: DEFAULT_RISK_LABELS.high }],
				}
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({
					state: 'error',
					reason: 'publish-failed',
					labelFailed: true,
				})
				expect(getLabelWrites(fake)).toEqual([])
				expect(fake.writes.map(write => write.state)).toEqual(['error'])
			})
	)
	test.effect(
		'a revocation with a timeline without the head removes no label',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				fake.items.splice(0)
				fake.api.command.pullRequest = {
					...fake.api.command.pullRequest,
					labels: [{ name: DEFAULT_RISK_LABELS.high }],
				}
				expect(
					yield* RiskFinishService.use(service =>
						service.revokeHead({
							pullNumber: 17,
							head: RISK_HEAD,
							labels: DEFAULT_RISK_LABELS,
						})
					).pipe(Effect.provide(fake.services))
				).toMatchObject({ state: 'none', labelFailed: true })
				expect(getLabelWrites(fake)).toEqual([])
			})
	)
})

/** A status another run of the app wrote on the head after this one, at another level. */
function otherRunStatus(id: number) {
	return riskStatus(
		{ id, state: 'failure' },
		{ level: 'high', nonce: OTHER_NONCE }
	)
}

/** The writes the fake API recorded after `from`. */
function getApiWritesAfter(fake: ReturnType<typeof riskFixture>, from: number) {
	return fake.api.writes.slice(from).map(write => write.method)
}

layer(APP_MODE_OWNED)('risk runs that lost their nonce', test => {
	test.effect(
		'a run that started unrated leaves a newer run its different label',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(
						riskInput({
							report: {
								...riskInput().report,
								rating: {
									...LOW_RATING,
									status: 'unrated',
									reason: 'coverage-gap',
									detail: 'missing',
								},
							},
						})
					)
				).pipe(Effect.provide(fake.services))
				expect(run.decision.status).toBe('unrated')
				const from = fake.api.writes.length
				fake.statuses.get(RISK_HEAD)?.unshift(otherRunStatus(900))
				fake.api.command.pullRequest = {
					...fake.api.command.pullRequest,
					labels: [{ name: DEFAULT_RISK_LABELS.high }],
				}
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({ state: 'none', reason: 'nonce-lost' })
				expect(getApiWritesAfter(fake, from)).toEqual([])
				expect(fake.writes.map(write => write.state)).toEqual(['error'])
			})
	)
	test.effect(
		'a nonce lost before the marker update changes neither marker nor labels',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				const from = fake.api.writes.length
				fake.statuses.get(RISK_HEAD)?.unshift(otherRunStatus(900))
				fake.api.command.pullRequest = {
					...fake.api.command.pullRequest,
					labels: [{ name: DEFAULT_RISK_LABELS.high }],
				}
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({ state: 'none', reason: 'nonce-lost', level: 'low' })
				expect(getApiWritesAfter(fake, from)).toEqual([])
				expect(fake.writes.map(write => write.state)).toEqual(['error'])
			})
	)
	test.effect(
		'a nonce lost after the marker update leaves the other run its labels',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				const from = fake.api.writes.length
				fake.statusSnapshots.push(undefined, [
					otherRunStatus(900),
					...(fake.statuses.get(RISK_HEAD) ?? []),
				])
				fake.api.command.pullRequest = {
					...fake.api.command.pullRequest,
					labels: [{ name: DEFAULT_RISK_LABELS.high }],
				}
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({ state: 'none', reason: 'nonce-lost', level: 'low' })
				expect(getApiWritesAfter(fake, from)).toEqual(['update'])
				expect(fake.writes.map(write => write.state)).toEqual(['error'])
			})
	)
	test.effect(
		'a nonce that cannot be read before the update stops the run',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				const from = fake.api.writes.length
				fake.failures.statuses.push(
					new GitHubApiError({ operation: 'statuses', reason: 'unavailable' })
				)
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({ state: 'error', reason: 'publish-failed' })
				expect(getApiWritesAfter(fake, from)).not.toContain('update')
				expect(fake.writes.map(write => write.state)).toEqual(['error'])
			})
	)
})

layer(SWITCHED_APP_OWNED)('risk grant after an app switch', test => {
	test.effect(
		'a newer previous-app status on the head never takes the nonce',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				fake.statuses.get(RISK_HEAD)?.unshift(
					riskStatus(
						{
							id: 900,
							creator: {
								login: PREVIOUS_APP_IDENTITY.restLogin,
								type: 'Bot',
							},
						},
						{ nonce: OTHER_NONCE }
					)
				)
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({ state: 'success', level: 'low' })
			})
	)
	test.effect(
		'a High the previous app wrote during the run stops the grant',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				fake.statuses.get(RISK_HEAD)?.push(
					riskStatus(
						{
							id: 0,
							state: 'failure',
							creator: {
								login: PREVIOUS_APP_IDENTITY.restLogin,
								type: 'Bot',
							},
						},
						{ level: 'high', nonce: OTHER_NONCE }
					)
				)
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({ state: 'error', reason: 'publish-failed' })
				expect(fake.writes.map(write => write.state)).toEqual(['error'])
			})
	)
})

layer(APP_MODE_OWNED)('risk grant on a base that is not the default', test => {
	test.effect(
		'a base branch that is no longer the default stops the grant',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				const pr = fake.api.command.pullRequest
				fake.api.command.pullRequest = {
					...pr,
					base: { ...pr.base, ref: 'release' },
				}
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({
					state: 'error',
					reason: 'head-moved',
					detail: 'the pull request is no longer into the default branch',
				})
				expect(fake.writes.map(write => write.state)).toEqual(['error'])
			})
	)
})

/** The edit history of the risk comment as GitHub lists it, newest first, a minute apart. */
function riskEdits(body: string, editors: readonly string[]) {
	return {
		body,
		total: editors.length,
		edits: editors.map((login, index) => ({
			id: `edit-${editors.length - 1 - index}`,
			editor:
				login === APP_IDENTITY.login
					? { __typename: 'Bot', login }
					: { __typename: 'User', login },
			editedAt: `2026-01-01T00:${String(59 - index).padStart(2, '0')}:00Z`,
			diff: body,
		})),
	}
}

/** GitHub's documented limit on the edits it keeps for one comment. */
const EDIT_RETENTION = 100

/** A risk comment history at GitHub's retention: `newest` editors over the app edits it kept. */
function retainedEdits(body: string, newest: readonly string[]) {
	const kept = riskEdits(
		body,
		Array.from({ length: EDIT_RETENTION }, () => APP_IDENTITY.login)
	).edits
	const added = riskEdits(body, newest).edits.map(edit => ({
		...edit,
		id: `new-${edit.id}`,
	}))
	return {
		body,
		total: EDIT_RETENTION,
		edits: [...added, ...kept].slice(0, EDIT_RETENTION),
	}
}

layer(APP_MODE_OWNED)('risk marker edits during the update', test => {
	test.effect(
		'only the app editing the marker since the read lets the grant through',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({ state: 'success', level: 'low' })
				expect(fake.reads.filter(read => read.startsWith('edits:'))).toEqual([
					'edits:comment-1',
					'edits:comment-1',
				])
			})
	)
	test.effect(
		'a person editing the marker between the read and the update leaves the run unrated',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				const body = fake.api.comments[0]?.body ?? ''
				fake.editSnapshots.push(
					riskEdits(body, []),
					riskEdits(body, [APP_IDENTITY.login, 'writer', APP_IDENTITY.login])
				)
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({ state: 'error', reason: 'marker-edited' })
				expect(fake.writes.map(write => write.state)).toEqual(['error'])
				expect(getLabelWrites(fake)).not.toContainEqual(
					expect.objectContaining({ method: 'label' })
				)
			})
	)
	test.effect(
		'a marker that changed between its read and the edit read is not updated',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				const from = fake.api.writes.length
				fake.editSnapshots.push(riskEdits('changed', ['writer']))
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({ state: 'error', reason: 'marker-edited' })
				expect(getApiWritesAfter(fake, from)).not.toContain('update')
			})
	)
	for (const failure of ['before', 'after'] as const)
		test.effect(
			`an edit history that cannot be read ${failure} the update stops the grant`,
			() =>
				Effect.gen(function* () {
					const fake = riskFixture()
					const run = yield* RiskStartService.use(service =>
						service.startFull(riskInput())
					).pipe(Effect.provide(fake.services))
					const error = new GitHubApiError({
						operation: 'edits',
						reason: 'unavailable',
					})
					fake.failures.edits.push(
						...(failure === 'before' ? [error] : [undefined, error])
					)
					expect(
						yield* RiskFinishService.use(service => service.finish(run)).pipe(
							Effect.provide(fake.services)
						)
					).toMatchObject({ state: 'error', reason: 'publish-failed' })
					expect(fake.writes.map(write => write.state)).toEqual(['error'])
				})
		)
	test.effect(
		"at GitHub's edit retention the app's own update still lets the grant through",
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				const body = fake.api.comments[0]?.body ?? ''
				fake.editSnapshots.push(
					retainedEdits(body, []),
					retainedEdits(body, [APP_IDENTITY.login])
				)
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({ state: 'success', level: 'low' })
			})
	)
	test.effect(
		"at GitHub's edit retention a person's edit since the read still stops the grant",
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				const body = fake.api.comments[0]?.body ?? ''
				fake.editSnapshots.push(
					retainedEdits(body, []),
					retainedEdits(body, [APP_IDENTITY.login, 'writer'])
				)
				expect(
					yield* RiskFinishService.use(service => service.finish(run)).pipe(
						Effect.provide(fake.services)
					)
				).toMatchObject({ state: 'error', reason: 'marker-edited' })
				expect(fake.writes.map(write => write.state)).toEqual(['error'])
			})
	)
	test.effect(
		'an update that never shows in the edit history stops the grant after the retries',
		() =>
			Effect.gen(function* () {
				const fake = riskFixture()
				const run = yield* RiskStartService.use(service =>
					service.startFull(riskInput())
				).pipe(Effect.provide(fake.services))
				const body = fake.api.comments[0]?.body ?? ''
				fake.editSnapshots.push(
					...Array.from({ length: EDIT_LAG_RETRIES + 2 }, () =>
						riskEdits(body, [])
					)
				)
				const finished = yield* RiskFinishService.use(service =>
					service.finish(run)
				).pipe(Effect.provide(fake.services), Effect.forkChild)
				yield* TestClock.adjust('1 minute')
				expect(yield* Fiber.join(finished)).toMatchObject({
					state: 'error',
					reason: 'publish-failed',
					detail:
						"the risk comment's edit history does not show this run's update",
				})
				expect(
					fake.reads.filter(read => read.startsWith('edits:'))
				).toHaveLength(EDIT_LAG_RETRIES + 2)
				expect(fake.writes.map(write => write.state)).toEqual(['error'])
			})
	)
})
