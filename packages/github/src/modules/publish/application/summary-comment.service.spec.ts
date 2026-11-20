import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import { GitHubConfig } from '../../../platform/github.config'
import { GitHubApiError } from '../../../platform/github.errors'
import { provideOwnedIdentities } from '../../../platform/owned-identities.context'
import { githubApiFake } from '../../../shared/mocks/github-api-fake.helper'
import { GITHUB_SETTINGS } from '../../../shared/mocks/github-http.helper'
import {
	APP_IDENTITY,
	APP_MODE_OWNED,
	appSummary,
	SUMMARY_MARKER,
} from '../../../shared/mocks/publish-test.helper'
import { parseSummaryMarker } from '../domain/publish-marker.parser'
import { toMarkerComment } from '../presentation/thread-comment.formatter'
import {
	SummaryCommentService,
	SummaryCommentServiceLive,
	type SummaryRender,
} from './summary-comment.service'

/** A render that preserves the prior state while counting this run. */
const render: SummaryRender = current => {
	const marker = {
		...SUMMARY_MARKER,
		...current?.marker,
		runs: (current?.marker.runs ?? 0) + 1,
	}
	return { marker, body: toMarkerComment('summary', marker) }
}

/** Summary writes over the recording API and a chosen token identity. */
function setup(current = APP_IDENTITY) {
	const fake = githubApiFake(current)
	const service = SummaryCommentServiceLive.pipe(
		Layer.provide(
			Layer.merge(
				fake.api,
				Layer.succeed(GitHubConfig, { ...GITHUB_SETTINGS, identity: current })
			)
		)
	)
	return { fake, service }
}

/** A previous identity's summary with completed state that must survive a switch. */
function priorSummary() {
	return appSummary(
		{ ...SUMMARY_MARKER, runs: 3, head: 'finished-head', finished: true },
		{
			id: 'previous-node',
			databaseId: 101,
			author: { __typename: 'Bot', login: GITHUB_ACTIONS_IDENTITY.login },
		}
	)
}

/** A refused or unanswered GitHub write. */
function writeError(status?: number) {
	return new GitHubApiError({
		operation: 'create',
		reason: 'write refused',
		...(status === undefined ? {} : { status }),
	})
}

layer(APP_MODE_OWNED)('SummaryCommentService identity switches', test => {
	test.effect(
		'switches to the app, carries run/head/finished and leaves exactly one visible summary',
		() =>
			Effect.gen(function* () {
				const { fake, service } = setup()
				fake.comments.push(priorSummary())
				const summary = yield* SummaryCommentService.use(api =>
					api.write(17, render)
				).pipe(Effect.provide(service))
				expect(summary).toMatchObject({
					marker: { runs: 4, head: 'finished-head', finished: true },
					cleanup: 'minimized',
				})
				expect(fake.writes.map(write => write.method)).toEqual([
					'create',
					'minimize',
				])
				expect(
					fake.comments.filter(comment => !comment.isMinimized)
				).toHaveLength(1)
				expect(
					fake.comments.find(comment => !comment.isMinimized)?.author?.login
				).toBe(APP_IDENTITY.login)
				expect(fake.writes.filter(write => write.method === 'update')).toEqual(
					[]
				)
			})
	)
	test.effect(
		'falls back to deleting a previous summary when minimization is refused',
		() =>
			Effect.gen(function* () {
				const { fake, service } = setup()
				fake.comments.push(priorSummary())
				fake.failures.minimize.push(writeError(403))
				expect(
					yield* SummaryCommentService.use(api => api.write(17, render)).pipe(
						Effect.provide(service)
					)
				).toMatchObject({ cleanup: 'deleted' })
				expect(fake.writes.map(write => write.method)).toEqual([
					'create',
					'minimize',
					'delete',
				])
				expect(fake.comments.map(comment => comment.author?.login)).toEqual([
					APP_IDENTITY.login,
				])
			})
	)
	test.effect(
		'reports kept without failing and retries cleanup on the next write',
		() =>
			Effect.gen(function* () {
				const { fake, service } = setup()
				fake.comments.push(priorSummary())
				fake.failures.minimize.push(writeError(403))
				fake.failures.delete.push(writeError(403))
				const summaries = yield* SummaryCommentService.pipe(
					Effect.provide(service)
				)
				expect(yield* summaries.write(17, render)).toMatchObject({
					cleanup: 'kept',
					marker: { runs: 4 },
				})
				expect(
					fake.comments.filter(comment => !comment.isMinimized)
				).toHaveLength(2)
				expect(yield* summaries.write(17, render)).toMatchObject({
					cleanup: 'minimized',
					marker: { runs: 5 },
				})
				expect(fake.writes.map(write => write.method)).toEqual([
					'create',
					'minimize',
					'delete',
					'update',
					'minimize',
				])
				expect(
					fake.writes
						.filter(write => write.method === 'update')
						.map(write => write.id)
				).toEqual([1])
				expect(
					fake.comments.filter(comment => !comment.isMinimized)
				).toHaveLength(1)
			})
	)
	test.effect(
		'prefers and edits the oldest app summary over a higher previous run count',
		() =>
			Effect.gen(function* () {
				const { fake, service } = setup()
				fake.comments.push(
					priorSummary(),
					appSummary({ ...SUMMARY_MARKER, runs: 1 }),
					appSummary(
						{ ...SUMMARY_MARKER, runs: 50 },
						{ databaseId: 102, id: 'newer-app' }
					)
				)
				const summaries = yield* SummaryCommentService.pipe(
					Effect.provide(service)
				)
				expect(yield* summaries.read(17)).toMatchObject({
					id: 100,
					mine: true,
					marker: { runs: 1 },
				})
				expect(yield* summaries.readPrior(17)).toMatchObject({ runs: 1 })
				expect(yield* summaries.write(17, render)).toMatchObject({
					marker: { runs: 2 },
				})
				expect(
					fake.writes
						.filter(write => write.method === 'update')
						.map(write => write.id)
				).toEqual([100])
				expect(fake.writes.some(write => write.method === 'create')).toBe(false)
			})
	)
	for (const identity of [APP_IDENTITY, GITHUB_ACTIONS_IDENTITY])
		test.effect(`never reads a minimized ${identity.login} summary`, () =>
			Effect.gen(function* () {
				const { fake, service } = setup()
				fake.comments.push(
					appSummary(SUMMARY_MARKER, {
						isMinimized: true,
						author: { __typename: 'Bot', login: identity.login },
					})
				)
				const summaries = yield* SummaryCommentService.pipe(
					Effect.provide(service)
				)
				expect(yield* summaries.read(17)).toBeUndefined()
				expect(yield* summaries.readPrior(17)).toBeUndefined()
				expect(fake.writes).toEqual([])
			})
		)
	for (const editor of [
		{ __typename: 'User', login: 'contributor' },
		{ __typename: 'Bot', login: APP_IDENTITY.login },
	])
		test.effect(
			`an earlier summary edited by ${editor.__typename} ${editor.login} starts at run one`,
			() =>
				Effect.gen(function* () {
					const { fake, service } = setup()
					fake.comments.push({ ...priorSummary(), editor })
					expect(
						yield* SummaryCommentService.use(api => api.write(17, render)).pipe(
							Effect.provide(service)
						)
					).toMatchObject({ marker: { runs: 1 }, cleanup: 'none' })
					expect(fake.writes.map(write => write.method)).toEqual(['create'])
				})
		)
	test.effect(
		'two creates update the older app marker and delete this run’s newer comment',
		() =>
			Effect.gen(function* () {
				const { fake, service } = setup()
				const older = appSummary({
					...SUMMARY_MARKER,
					runs: 7,
					head: 'other-run-head',
					finished: true,
				})
				fake.comments.push(older)
				fake.commentSnapshots.push([])
				expect(
					yield* SummaryCommentService.use(api => api.write(17, render)).pipe(
						Effect.provide(service)
					)
				).toMatchObject({
					marker: { runs: 8, head: 'other-run-head', finished: true },
				})
				expect(fake.writes.map(write => write.method)).toEqual([
					'create',
					'update',
					'delete',
				])
				expect(fake.writes[1]).toMatchObject({ id: older.databaseId })
				expect(fake.writes[2]).toMatchObject({ id: 1 })
				expect(fake.comments).toHaveLength(1)
				expect(parseSummaryMarker(fake.comments[0]?.body ?? '')).toMatchObject({
					runs: 8,
					head: 'other-run-head',
				})
			})
	)
	for (const status of [undefined, 500, 503])
		test.effect(
			`an unanswered create ${status} recovers the stored summary without a second create`,
			() =>
				Effect.gen(function* () {
					const { fake, service } = setup()
					fake.comments.push(appSummary({ ...SUMMARY_MARKER, runs: 3 }))
					fake.commentSnapshots.push([])
					fake.failures.create.push(writeError(status))
					expect(
						yield* SummaryCommentService.use(api => api.write(17, render)).pipe(
							Effect.provide(service)
						)
					).toMatchObject({ marker: { runs: 4 } })
					expect(fake.writes.map(write => write.method)).toEqual([
						'create',
						'update',
					])
					expect(fake.commentReads).toEqual([17, 17])
					expect(fake.comments).toHaveLength(1)
				})
		)
	for (const status of [undefined, 500])
		test.effect(
			`an unanswered create ${status} with no stored comment returns the original error`,
			() =>
				Effect.gen(function* () {
					const { fake, service } = setup()
					const original = writeError(status)
					fake.failures.create.push(original)
					expect(
						yield* SummaryCommentService.use(api => api.write(17, render)).pipe(
							Effect.provide(service),
							Effect.flip
						)
					).toBe(original)
					expect(fake.writes.map(write => write.method)).toEqual(['create'])
					expect(fake.commentReads).toEqual([17, 17])
				})
		)
	test.effect(
		'offline with only a previous identity summary makes no write',
		() =>
			Effect.gen(function* () {
				const { fake, service } = setup()
				fake.comments.push(priorSummary())
				expect(
					yield* SummaryCommentService.use(api =>
						api.publishStatus({
							pullNumber: 17,
							head: 'head',
							engineCommit: undefined,
							status: 'offline',
						})
					).pipe(Effect.provide(service))
				).toBe(false)
				expect(fake.writes).toEqual([])
			})
	)
	test.effect(
		'an update returning 404 creates a replacement without editing the old identity',
		() =>
			Effect.gen(function* () {
				const { fake, service } = setup()
				fake.comments.push(priorSummary(), appSummary())
				fake.failures.update.push(writeError(404))
				expect(
					yield* SummaryCommentService.use(api => api.write(17, render)).pipe(
						Effect.provide(service)
					)
				).toMatchObject({ cleanup: 'minimized', marker: { runs: 2 } })
				expect(
					fake.writes
						.filter(write => write.method === 'update')
						.map(write => write.id)
				).toEqual([100])
				expect(fake.writes.map(write => write.method)).toEqual([
					'update',
					'create',
					'minimize',
				])
			})
	)
})

layer(Layer.empty)('SummaryCommentService return to token mode', test => {
	test.effect(
		'creates as github-actions over the app marker and hides the app summary',
		() =>
			Effect.gen(function* () {
				const { fake, service } = setup(GITHUB_ACTIONS_IDENTITY)
				fake.comments.push(
					appSummary({
						...SUMMARY_MARKER,
						runs: 3,
						head: 'app-head',
						finished: true,
					})
				)
				expect(
					yield* SummaryCommentService.use(api => api.write(17, render)).pipe(
						Effect.provide(service),
						provideOwnedIdentities(GITHUB_ACTIONS_IDENTITY, [
							APP_IDENTITY.login,
						])
					)
				).toMatchObject({
					cleanup: 'minimized',
					marker: { runs: 4, head: 'app-head', finished: true },
				})
				expect(fake.writes.map(write => write.method)).toEqual([
					'create',
					'minimize',
				])
				expect(
					fake.comments
						.filter(comment => !comment.isMinimized)
						.map(comment => comment.author?.login)
				).toEqual([GITHUB_ACTIONS_IDENTITY.login])
			})
	)
})
