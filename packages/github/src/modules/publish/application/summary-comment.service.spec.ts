import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import { GitHubApiService } from '../../../platform/github-api.service'
import { GitHubConfig } from '../../../platform/github.config'
import { GitHubApiError } from '../../../platform/github.errors'
import { provideOwnedIdentities } from '../../../platform/owned-identities.context'
import {
	githubApiFake,
	type GitHubApiFakeOptions,
} from '../../../shared/mocks/github-api-fake.helper'
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
function setup(current = APP_IDENTITY, options: GitHubApiFakeOptions = {}) {
	const fake = githubApiFake(current, options)
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
		{
			...SUMMARY_MARKER,
			runs: 3,
			head: 'finished-head',
			finished: true,
			unthreadedBugs: 2,
		},
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
	for (const status of [undefined, 500, 503]) {
		test.effect(
			`a stored unanswered create ${status} counts migration once without an update or second create`,
			() =>
				Effect.gen(function* () {
					const { fake, service } = setup(APP_IDENTITY, {
						storeFailedCreates: true,
					})
					fake.comments.push(priorSummary())
					fake.failures.create.push(writeError(status))
					expect(
						yield* SummaryCommentService.use(api => api.write(17, render)).pipe(
							Effect.provide(service)
						)
					).toMatchObject({
						marker: {
							runs: 4,
							head: 'finished-head',
							finished: true,
							unthreadedBugs: 2,
						},
						cleanup: 'minimized',
					})
					const own = fake.comments.filter(
						comment => comment.author?.login === APP_IDENTITY.login
					)
					expect(own).toHaveLength(1)
					expect(parseSummaryMarker(own[0]?.body ?? '')).toMatchObject({
						runs: 4,
					})
					expect(own[0]?.body).toBe(
						fake.writes.find(write => write.method === 'create')?.body
					)
					expect(fake.writes.map(write => write.method)).toEqual([
						'create',
						'minimize',
					])
					expect(fake.commentReads).toEqual([17, 17])
				})
		)
		test.effect(
			`a stored unanswered create ${status} updates an older own marker and deletes only this run's comment`,
			() =>
				Effect.gen(function* () {
					const { fake, service } = setup(APP_IDENTITY, {
						storeFailedCreates: true,
					})
					const previous = priorSummary()
					const older = appSummary({
						...SUMMARY_MARKER,
						runs: 7,
						head: 'older-head',
						finished: true,
					})
					fake.comments.push(previous, older)
					fake.commentSnapshots.push([previous])
					fake.failures.create.push(writeError(status))
					expect(
						yield* SummaryCommentService.use(api => api.write(17, render)).pipe(
							Effect.provide(service)
						)
					).toMatchObject({
						marker: { runs: 8, head: 'older-head', finished: true },
						cleanup: 'minimized',
					})
					expect(fake.writes.map(write => write.method)).toEqual([
						'create',
						'update',
						'minimize',
						'delete',
					])
					expect(
						fake.writes
							.filter(write => write.method === 'update')
							.map(write => write.id)
					).toEqual([older.databaseId])
					expect(
						fake.writes
							.filter(write => write.method === 'delete')
							.map(write => write.id)
					).toEqual([1])
					expect(
						parseSummaryMarker(
							fake.comments.find(
								comment => comment.databaseId === older.databaseId
							)?.body ?? ''
						)
					).toMatchObject({ runs: 8, head: 'older-head' })
					expect(
						fake.comments.filter(
							comment => comment.author?.login === APP_IDENTITY.login
						)
					).toHaveLength(1)
				})
		)
	}
	test.effect(
		'a transient duplicate delete keeps both summaries until the next write repairs them',
		() =>
			Effect.gen(function* () {
				const { fake, service } = setup()
				const older = appSummary({ ...SUMMARY_MARKER, runs: 3 })
				const newer = appSummary(
					{ ...SUMMARY_MARKER, runs: 20 },
					{ databaseId: 102, id: 'newer-app' }
				)
				fake.comments.push(older, newer)
				fake.failures.delete.push(writeError(503))
				const summaries = yield* SummaryCommentService.pipe(
					Effect.provide(service)
				)
				expect(yield* summaries.write(17, render)).toMatchObject({
					marker: { runs: 4 },
					cleanup: 'kept',
				})
				expect(fake.comments.map(comment => comment.databaseId)).toEqual([
					older.databaseId,
					newer.databaseId,
				])
				expect(parseSummaryMarker(fake.comments[0]?.body ?? '')).toMatchObject({
					runs: 4,
				})
				expect(fake.comments[1]).toEqual(newer)
				expect(yield* summaries.write(17, render)).toMatchObject({
					marker: { runs: 5 },
					cleanup: 'none',
				})
				expect(fake.comments.map(comment => comment.databaseId)).toEqual([
					older.databaseId,
				])
				expect(fake.writes).toEqual([
					expect.objectContaining({ method: 'update', id: older.databaseId }),
					{ method: 'delete', id: newer.databaseId },
					expect.objectContaining({ method: 'update', id: older.databaseId }),
					{ method: 'delete', id: newer.databaseId },
				])
			})
	)
	for (const storedFailure of [false, true])
		test.effect(
			`a ${storedFailure ? 'stored unanswered create is kept' : 'successful create is deleted'} and the write fails when updating the older summary fails`,
			() =>
				Effect.gen(function* () {
					const { fake, service } = setup(APP_IDENTITY, {
						storeFailedCreates: storedFailure,
					})
					const previous = priorSummary()
					const older = appSummary({
						...SUMMARY_MARKER,
						runs: 7,
						head: 'older-head',
					})
					fake.comments.push(previous, older)
					fake.commentSnapshots.push([previous])
					if (storedFailure) fake.failures.create.push(writeError())
					const updateError = new GitHubApiError({
						operation: 'update',
						reason: 'older summary unavailable',
						status: 503,
					})
					fake.failures.update.push(updateError)
					const summaries = yield* SummaryCommentService.pipe(
						Effect.provide(service)
					)
					expect(yield* Effect.flip(summaries.write(17, render))).toBe(
						updateError
					)
					expect(fake.comments.map(comment => comment.databaseId)).toEqual(
						storedFailure
							? [previous.databaseId, older.databaseId, 1]
							: [previous.databaseId, older.databaseId]
					)
					expect(fake.writes).toEqual([
						expect.objectContaining({ method: 'create' }),
						expect.objectContaining({ method: 'update', id: older.databaseId }),
						...(storedFailure ? [] : [{ method: 'delete', id: 1 }]),
					])
					expect(fake.comments.slice(0, 2)).toEqual([previous, older])
					expect(yield* summaries.write(17, render)).toMatchObject({
						marker: { runs: 8, head: 'older-head' },
						cleanup: 'minimized',
						created: false,
					})
					expect(
						fake.comments
							.filter(comment => !comment.isMinimized)
							.map(comment => comment.databaseId)
					).toEqual([older.databaseId])
				})
		)
	for (const status of [undefined, 503])
		test.effect(
			`a transient minimize ${status} keeps the previous summary without deleting and retries on the next write`,
			() =>
				Effect.gen(function* () {
					const { fake, service } = setup()
					const previous = priorSummary()
					fake.comments.push(previous)
					fake.failures.minimize.push(
						new GitHubApiError({
							operation: 'minimize',
							reason: 'request timed out',
							...(status === undefined ? {} : { status }),
						})
					)
					const summaries = yield* SummaryCommentService.pipe(
						Effect.provide(service)
					)
					expect(yield* summaries.write(17, render)).toMatchObject({
						cleanup: 'kept',
						marker: { runs: 4 },
					})
					expect(
						fake.comments.find(
							comment => comment.databaseId === previous.databaseId
						)
					).toEqual(previous)
					expect(
						fake.comments.filter(comment => !comment.isMinimized)
					).toHaveLength(2)
					expect(fake.writes.map(write => write.method)).toEqual([
						'create',
						'minimize',
					])
					expect(yield* summaries.write(17, render)).toMatchObject({
						cleanup: 'minimized',
						marker: { runs: 5 },
					})
					expect(fake.writes.map(write => write.method)).toEqual([
						'create',
						'minimize',
						'update',
						'minimize',
					])
					expect(
						fake.writes
							.filter(write => write.method === 'update')
							.map(write => write.id)
					).toEqual([1])
					expect(
						fake.comments.find(
							comment => comment.databaseId === previous.databaseId
						)
					).toEqual({ ...previous, isMinimized: true })
					expect(
						fake.comments.filter(comment => !comment.isMinimized)
					).toHaveLength(1)
				})
		)
	test.effect(
		'GraphQL errors declining minimize delete the previous identity summary without updating it',
		() =>
			Effect.gen(function* () {
				const { fake, service } = setup()
				fake.comments.push(priorSummary())
				fake.failures.minimize.push(
					new GitHubApiError({
						operation: 'minimize',
						reason: 'not minimizable',
						graphqlErrors: true,
						graphqlTypes: ['UNPROCESSABLE'],
					})
				)
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
				expect(fake.writes[2]).toEqual({ method: 'delete', id: 101 })
				expect(fake.comments.map(comment => comment.author?.login)).toEqual([
					APP_IDENTITY.login,
				])
			})
	)
	for (const cleanup of ['minimized', 'deleted'] as const)
		test.effect(
			`offline migration preserves the whole previous marker unfinished and leaves the old summary ${cleanup}`,
			() =>
				Effect.gen(function* () {
					const { fake, service } = setup()
					const previous = priorSummary()
					fake.comments.push(previous)
					if (cleanup === 'deleted')
						fake.failures.minimize.push(writeError(403))
					expect(
						yield* SummaryCommentService.use(api =>
							api.publishStatus({
								pullNumber: 17,
								head: 'new-head',
								engineCommit: undefined,
								status: 'offline',
							})
						).pipe(Effect.provide(service))
					).toBe(true)
					expect(fake.writes.map(write => write.method)).toEqual(
						cleanup === 'deleted'
							? ['create', 'minimize', 'delete']
							: ['create', 'minimize']
					)
					const visible = fake.comments.filter(comment => !comment.isMinimized)
					expect(visible).toHaveLength(1)
					expect(visible[0]?.author?.login).toBe(APP_IDENTITY.login)
					expect(parseSummaryMarker(visible[0]?.body ?? '')).toEqual({
						...parseSummaryMarker(previous.body),
						finished: false,
					})
					expect(
						fake.comments.find(
							comment => comment.databaseId === previous.databaseId
						)
					).toEqual(
						cleanup === 'deleted'
							? undefined
							: { ...previous, isMinimized: true }
					)
					expect(
						fake.writes.filter(write => write.method === 'update')
					).toEqual([])
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

layer(APP_MODE_OWNED)('SummaryCommentService reconciliation failures', test => {
	test.effect(
		'a failed read after an answered create preserves the read error without another create or cleanup',
		() =>
			Effect.gen(function* () {
				const { fake, service } = setup()
				const previous = priorSummary()
				const older = appSummary({ ...SUMMARY_MARKER, runs: 7 })
				const readError = new GitHubApiError({
					operation: 'listComments',
					reason: 'comments unavailable after create',
					status: 503,
				})
				fake.comments.push(previous, older)
				fake.commentSnapshots.push([previous])
				const api = yield* GitHubApiService.pipe(Effect.provide(fake.api))
				const { createIssueComment } = api
				const createIssueCommentSpy = vi
					.spyOn(api, 'createIssueComment')
					.mockImplementation((pullNumber, body) =>
						createIssueComment(pullNumber, body).pipe(
							Effect.tap(() =>
								Effect.sync(() => {
									fake.failures.listComments.push(readError)
								})
							)
						)
					)
				expect(
					yield* SummaryCommentService.use(summaries =>
						summaries.write(17, render)
					).pipe(Effect.provide(service), Effect.flip)
				).toBe(readError)
				expect(createIssueCommentSpy).toHaveBeenCalledTimes(1)
				expect(fake.commentReads).toEqual([17, 17])
				expect(fake.failures.listComments).toEqual([])
				expect(fake.writes).toEqual([
					expect.objectContaining({ method: 'create', pullNumber: 17 }),
				])
				expect(fake.comments.slice(0, 2)).toEqual([previous, older])
				expect(fake.comments.map(comment => comment.databaseId)).toEqual([
					previous.databaseId,
					older.databaseId,
					1,
				])
			})
	)
	test.effect(
		'a successful create preserves the update error when deleting its comment also fails',
		() =>
			Effect.gen(function* () {
				const { fake, service } = setup()
				const previous = priorSummary()
				const older = appSummary({
					...SUMMARY_MARKER,
					runs: 7,
					finished: true,
				})
				const updateError = new GitHubApiError({
					operation: 'update',
					reason: 'older summary unavailable',
					status: 503,
				})
				const deleteError = new GitHubApiError({
					operation: 'delete',
					reason: 'delete denied',
					status: 403,
				})
				fake.comments.push(previous, older)
				fake.commentSnapshots.push([previous])
				fake.failures.update.push(updateError)
				fake.failures.delete.push(deleteError)
				expect(
					yield* SummaryCommentService.use(api => api.write(17, render)).pipe(
						Effect.provide(service),
						Effect.flip
					)
				).toBe(updateError)
				expect(fake.writes).toEqual([
					expect.objectContaining({ method: 'create' }),
					expect.objectContaining({ method: 'update', id: older.databaseId }),
					{ method: 'delete', id: 1 },
				])
				expect(fake.comments.slice(0, 2)).toEqual([previous, older])
				expect(fake.comments.map(comment => comment.databaseId)).toEqual([
					101, 100, 1,
				])
				expect(fake.failures.delete).toEqual([])
			})
	)
	for (const storedFailure of [false, true])
		test.effect(
			`offline reconciliation ${storedFailure ? 'keeps its stored unanswered' : 'deletes its successful'} create and fails when the older finished summary update answers 503`,
			() =>
				Effect.gen(function* () {
					const { fake, service } = setup(APP_IDENTITY, {
						storeFailedCreates: storedFailure,
					})
					const previous = priorSummary()
					const older = appSummary({
						...SUMMARY_MARKER,
						runs: 7,
						head: 'older-head',
						finished: true,
					})
					const updateError = new GitHubApiError({
						operation: 'update',
						reason: 'older summary unavailable',
						status: 503,
					})
					fake.comments.push(previous, older)
					fake.commentSnapshots.push([previous])
					if (storedFailure) fake.failures.create.push(writeError())
					fake.failures.update.push(updateError)
					expect(
						yield* SummaryCommentService.use(api =>
							api.publishStatus({
								pullNumber: 17,
								head: 'new-head',
								engineCommit: undefined,
								status: 'offline',
							})
						).pipe(Effect.provide(service), Effect.flip)
					).toBe(updateError)
					expect(fake.writes).toEqual([
						expect.objectContaining({ method: 'create' }),
						expect.objectContaining({ method: 'update', id: older.databaseId }),
						...(storedFailure ? [] : [{ method: 'delete', id: 1 }]),
					])
					expect(
						parseSummaryMarker(
							fake.writes[0]?.method === 'create' ? fake.writes[0].body : ''
						)
					).toMatchObject({ finished: false })
					expect(fake.comments.slice(0, 2)).toEqual([previous, older])
					expect(fake.comments.map(comment => comment.databaseId)).toEqual(
						storedFailure
							? [previous.databaseId, older.databaseId, 1]
							: [previous.databaseId, older.databaseId]
					)
				})
		)
})

layer(APP_MODE_OWNED)(
	'SummaryCommentService unanswered create ownership',
	test => {
		for (const status of [undefined, 500, 503]) {
			test.effect(
				`an unanswered create ${status} never claims an identical summary present before the create`,
				() =>
					Effect.gen(function* () {
						const { fake, service } = setup()
						const same = render(undefined)
						const oldest = appSummary(same.marker, { body: same.body })
						const existing = appSummary(same.marker, {
							id: 'existing-duplicate',
							databaseId: 102,
							body: same.body,
						})
						const updateError = new GitHubApiError({
							operation: 'update',
							reason: 'existing duplicate unavailable',
							status: 503,
						})
						fake.comments.push(existing)
						fake.commentSnapshots.push([oldest, existing])
						fake.failures.update.push(writeError(404), updateError)
						fake.failures.create.push(writeError(status))
						expect(
							yield* SummaryCommentService.use(api =>
								api.write(17, () => same)
							).pipe(Effect.provide(service), Effect.flip)
						).toBe(updateError)
						expect(fake.writes).toEqual([
							{ method: 'update', id: oldest.databaseId, body: same.body },
							{ method: 'create', pullNumber: 17, body: same.body },
							{ method: 'update', id: existing.databaseId, body: same.body },
						])
						expect(fake.comments).toEqual([existing])
						expect(fake.commentReads).toEqual([17, 17])
					})
			)
			test.effect(
				`two concurrent identical creates, one unanswered ${status}, never delete the newest new matching summary when updating the older fails`,
				() =>
					Effect.gen(function* () {
						const { fake, service } = setup()
						const same = render(undefined)
						const older = appSummary(same.marker, { body: same.body })
						const newer = appSummary(same.marker, {
							id: 'newer-summary',
							databaseId: 102,
							body: same.body,
						})
						const foreign = appSummary(same.marker, {
							id: 'foreign-summary',
							databaseId: 103,
							body: same.body,
							author: {
								__typename: 'Bot',
								login: GITHUB_ACTIONS_IDENTITY.login,
							},
						})
						const different = appSummary(same.marker, {
							id: 'different-summary',
							databaseId: 104,
							body: `different run${toMarkerComment('summary', same.marker)}`,
						})
						const updateError = new GitHubApiError({
							operation: 'update',
							reason: 'older summary unavailable',
							status: 503,
						})
						fake.comments.push(older, newer, foreign, different)
						fake.commentSnapshots.push([])
						fake.failures.create.push(writeError(status))
						fake.failures.update.push(updateError)
						expect(
							yield* SummaryCommentService.use(api =>
								api.write(17, () => same)
							).pipe(Effect.provide(service), Effect.flip)
						).toBe(updateError)
						expect(fake.writes).toEqual([
							{ method: 'create', pullNumber: 17, body: same.body },
							{ method: 'update', id: older.databaseId, body: same.body },
						])
						expect(fake.comments).toEqual([older, newer, foreign, different])
						expect(fake.commentReads).toEqual([17, 17])
					})
			)
		}
	}
)

layer(APP_MODE_OWNED)('SummaryCommentService cleanup classification', test => {
	for (const details of [
		{ graphqlErrors: true, graphqlTypes: ['RATE_LIMITED'] },
		{ status: 403, rateLimited: true },
		{ status: 403, reason: 'API rate limit exceeded' },
		{ status: 403, reason: 'You have exceeded a secondary rate limit' },
		{
			graphqlErrors: true,
			graphqlTypes: ['FORBIDDEN'],
			reason: 'You have exceeded a secondary rate limit',
		},
		{ status: 429 },
	] as const)
		test.effect(
			`hiding with ${JSON.stringify(details)} keeps the previous summary visible without deleting it`,
			() =>
				Effect.gen(function* () {
					const { fake, service } = setup()
					const previous = priorSummary()
					fake.comments.push(previous)
					fake.failures.minimize.push(
						new GitHubApiError({
							operation: 'minimize',
							reason: 'request failed',
							...details,
						})
					)
					expect(
						yield* SummaryCommentService.use(api => api.write(17, render)).pipe(
							Effect.provide(service)
						)
					).toMatchObject({ cleanup: 'kept', created: true })
					expect(fake.comments[0]).toEqual(previous)
					expect(
						fake.comments.filter(comment => !comment.isMinimized)
					).toHaveLength(2)
					expect(fake.writes.map(write => write.method)).toEqual([
						'create',
						'minimize',
					])
				})
		)
	test.effect(
		'a secondary rate limit typed FORBIDDEN keeps the previous summary, and the next write hides it',
		() =>
			Effect.gen(function* () {
				const { fake, service } = setup()
				const previous = priorSummary()
				fake.comments.push(previous)
				fake.failures.minimize.push(
					new GitHubApiError({
						operation: 'minimize',
						reason: 'You have exceeded a secondary rate limit',
						graphqlErrors: true,
						graphqlTypes: ['FORBIDDEN'],
					})
				)
				const summaries = yield* SummaryCommentService.pipe(
					Effect.provide(service)
				)
				expect(yield* summaries.write(17, render)).toMatchObject({
					cleanup: 'kept',
				})
				expect(fake.comments[0]).toEqual(previous)
				expect(yield* summaries.write(17, render)).toMatchObject({
					cleanup: 'minimized',
				})
				expect(fake.comments[0]).toEqual({ ...previous, isMinimized: true })
				expect(fake.writes.map(write => write.method)).toEqual([
					'create',
					'minimize',
					'update',
					'minimize',
				])
			})
	)
	for (const previousIdentity of [true, false])
		test.effect(
			`a 404 deleting a ${previousIdentity ? 'previous identity summary reports deleted' : 'current identity duplicate reports none'}`,
			() =>
				Effect.gen(function* () {
					const { fake, service } = setup()
					const oldest = appSummary()
					const disappeared = previousIdentity
						? priorSummary()
						: appSummary(SUMMARY_MARKER, {
								id: 'deleted-duplicate',
								databaseId: 102,
							})
					fake.comments.push(oldest)
					fake.commentSnapshots.push([oldest, disappeared])
					if (previousIdentity) fake.failures.minimize.push(writeError(403))
					fake.failures.delete.push(
						new GitHubApiError({
							operation: 'delete',
							reason: 'not found',
							status: 404,
						})
					)
					expect(
						yield* SummaryCommentService.use(api => api.write(17, render)).pipe(
							Effect.provide(service)
						)
					).toMatchObject({
						cleanup: previousIdentity ? 'deleted' : 'none',
						created: false,
					})
					expect(fake.writes).toEqual([
						expect.objectContaining({
							method: 'update',
							id: oldest.databaseId,
						}),
						...(previousIdentity
							? [{ method: 'minimize', id: disappeared.id }]
							: []),
						{ method: 'delete', id: disappeared.databaseId },
					])
					expect(fake.comments.map(comment => comment.databaseId)).toEqual([
						oldest.databaseId,
					])
					expect(fake.failures.delete).toEqual([])
				})
		)
})

layer(APP_MODE_OWNED)('SummaryCommentService offline created result', test => {
	for (const scenario of ['replacement', 'update', 'settled-create'] as const)
		test.effect(
			`publishStatus returns whether the kept summary was created for ${scenario}`,
			() =>
				Effect.gen(function* () {
					const { fake, service } = setup()
					const oldest = appSummary({ ...SUMMARY_MARKER, finished: true })
					fake.comments.push(oldest)
					if (scenario === 'replacement') {
						fake.commentSnapshots.push([oldest])
						fake.comments.splice(0)
						fake.failures.update.push(writeError(404))
					}
					if (scenario === 'settled-create') fake.commentSnapshots.push([])
					expect(
						yield* SummaryCommentService.use(api =>
							api.publishStatus({
								pullNumber: 17,
								head: 'new-head',
								engineCommit: undefined,
								status: 'offline',
							})
						).pipe(Effect.provide(service))
					).toBe(scenario === 'replacement')
					expect(fake.writes.map(write => write.method)).toEqual(
						scenario === 'replacement'
							? ['update', 'create']
							: scenario === 'update'
								? ['update']
								: ['create', 'update', 'delete']
					)
					expect(fake.comments).toHaveLength(1)
					expect(fake.comments[0]?.databaseId).toBe(
						scenario === 'replacement' ? 2 : oldest.databaseId
					)
					expect(
						parseSummaryMarker(fake.comments[0]?.body ?? '')
					).toMatchObject({ finished: false })
				})
		)
})
