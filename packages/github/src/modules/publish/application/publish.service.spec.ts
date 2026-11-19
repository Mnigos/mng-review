import { layer } from '@effect/vitest'
import { GitService } from '@mng-review/engine'
import { Effect, Layer, Redacted } from 'effect'
import { GitHubConfig } from '../../../platform/github.config'
import { GitHubApiError } from '../../../platform/github.errors'
import {
	cleanupRepos,
	createRepo,
	gitLayer,
} from '../../../shared/mocks/git-test.helper'
import { githubApiFake } from '../../../shared/mocks/github-api-fake.helper'
import {
	bug,
	report,
	RULES,
	reviewThread,
	SUMMARY_MARKER,
} from '../../../shared/mocks/publish-test.helper'
import {
	parseSummaryMarker,
	parseFindingMarker,
} from '../domain/publish-marker.parser'
import { BOT_LOGIN } from '../domain/publish.constants'
import { toMarkerComment } from '../presentation/thread-comment.formatter'
import { PublishService, PublishServiceLive } from './publish.service'

/** Real git history with a finding on a changed head line and a recording API. */
function setup() {
	const repo = createRepo()
	const original = `${Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n')}\n`
	repo.write(bug().path, original)
	const base = repo.commit()
	repo.write(bug().path, original.replace('line 10\n', 'changed 10\n'))
	const head = repo.commit()
	const fake = githubApiFake()
	const dependencies = Layer.mergeAll(
		fake.api,
		gitLayer(repo.root),
		Layer.succeed(GitHubConfig, {
			serverUrl: 'https://github.com',
			apiUrl: 'https://api.github.com',
			graphqlUrl: 'https://api.github.com/graphql',
			owner: 'example',
			name: 'project',
			token: Redacted.make('fixture'),
		})
	)
	const publisher = PublishServiceLive.pipe(Layer.provide(dependencies))
	const input = {
		pullNumber: 17,
		head,
		engineCommit: 'engine',
		rules: RULES,
		report: {
			...report(),
			planReport: {
				...report().planReport,
				change: {
					base: { ref: 'main', commit: base },
					head: { ref: 'HEAD', commit: head },
					mergeBase: base,
					files: [
						{
							path: bug().path,
							status: 'modified' as const,
							additions: 1,
							deletions: 1,
							binary: false,
							sizeBytes: original.length,
						},
					],
				},
			},
		},
	}
	return { repo, original, base, head, fake, publisher, input }
}

/** A known existing bot-owned summary. */
function summary() {
	return {
		databaseId: 101,
		body: toMarkerComment('summary', SUMMARY_MARKER),
		author: { __typename: 'Bot', login: BOT_LOGIN },
		editor: null,
	}
}

/** A write refusal or unknown write result. */
function error(status?: number) {
	return new GitHubApiError({
		operation: 'write',
		reason: 'failure',
		...(status === undefined ? {} : { status }),
	})
}

afterEach(cleanupRepos)

layer(Layer.empty, { excludeTestServices: true })(
	'PublishServiceLive',
	test => {
		test.effect(
			'first run creates a review and summary, second edits only the summary and increments runs',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const publisher = yield* PublishService.pipe(
						Effect.provide(fixture.publisher)
					)
					expect(yield* publisher.publish(fixture.input)).toMatchObject({
						onLine: 1,
						repeated: 0,
						run: 1,
						verdict: 'needs fixes',
					})
					expect(fixture.fake.writes.map(call => call.method)).toEqual([
						'review',
						'create',
					])
					const [review] = fixture.fake.writes
					expect(review).toMatchObject({
						method: 'review',
						pullNumber: 17,
						input: {
							commitId: fixture.head,
							comments: [{ path: bug().path, line: bug().line }],
						},
					})
					expect(
						parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')?.runs
					).toBe(1)
					expect(yield* publisher.publish(fixture.input)).toMatchObject({
						onLine: 0,
						repeated: 1,
						run: 2,
					})
					expect(fixture.fake.writes.map(call => call.method)).toEqual([
						'review',
						'create',
						'update',
					])
					expect(
						parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
					).toMatchObject({ runs: 2, head: fixture.head })
				})
		)
		test.effect(
			'a thread edited by another user does not suppress the finding',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const thread = reviewThread()
					fixture.fake.threads.push({
						...thread,
						comments: {
							...thread.comments,
							nodes: thread.comments.nodes.map(comment => ({
								...comment,
								editor: { login: 'contributor' },
							})),
						},
					})
					const publisher = yield* PublishService.pipe(
						Effect.provide(fixture.publisher)
					)
					expect(yield* publisher.publish(fixture.input)).toMatchObject({
						onLine: 1,
						repeated: 0,
					})
				})
		)
		for (const refusals of [0, 1, 2])
			test.effect(
				`422 review falls back through ${refusals} single-comment refusals`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						fixture.fake.failures.review.push(error(422))
						fixture.fake.failures.comment.push(
							...Array.from({ length: refusals }, () => error(422))
						)
						const publisher = yield* PublishService.pipe(
							Effect.provide(fixture.publisher)
						)
						expect(yield* publisher.publish(fixture.input)).toMatchObject({
							onLine: refusals === 0 ? 1 : 0,
							onFile: refusals === 1 ? 1 : 0,
							inSummary: refusals === 2 ? 1 : 0,
							unposted: 0,
						})
						const singles = fixture.fake.writes.filter(
							call => call.method === 'comment'
						)
						expect(singles.map(call => call.input.line)).toEqual(
							refusals === 0 ? [bug().line] : [bug().line, undefined]
						)
						expect(fixture.fake.writes.at(-1)?.method).toBe('create')
					})
			)
		for (const status of [500, 503, undefined])
			test.effect(
				`unknown review result ${status} leaves threads unposted and writes only the summary`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						fixture.fake.failures.review.push(error(status))
						const publisher = yield* PublishService.pipe(
							Effect.provide(fixture.publisher)
						)
						expect(yield* publisher.publish(fixture.input)).toMatchObject({
							unposted: 1,
							onLine: 0,
							onFile: 0,
						})
						expect(fixture.fake.writes.map(call => call.method)).toEqual([
							'review',
							'create',
						])
					})
			)
		test.effect('recreates a summary whose update returned 404', () =>
			Effect.gen(function* () {
				const fixture = setup()
				fixture.fake.comments.push(summary())
				fixture.fake.failures.update.push(error(404))
				const publisher = yield* PublishService.pipe(
					Effect.provide(fixture.publisher)
				)
				yield* publisher.publish(fixture.input)
				expect(fixture.fake.writes.map(call => call.method)).toEqual([
					'review',
					'update',
					'create',
				])
				expect(fixture.fake.writes[1]).toMatchObject({
					method: 'update',
					id: 101,
				})
			})
		)
		test.effect(
			'status creates only when no summary exists, preserving the reviewed verdict',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const publisher = yield* PublishService.pipe(
						Effect.provide(fixture.publisher)
					)
					const input = {
						pullNumber: 17,
						head: fixture.head,
						engineCommit: undefined,
						status: 'Reviewer offline',
					}
					yield* publisher.publishStatus(input)
					expect(fixture.fake.writes.map(call => call.method)).toEqual([
						'create',
					])
					expect(
						parseSummaryMarker(fixture.fake.comments[0]?.body ?? '')
					).toMatchObject({ runs: 0 })
					yield* publisher.publishStatus({
						...input,
						status: 'Another failure',
					})
					expect(fixture.fake.writes).toHaveLength(1)
				})
		)
		for (const scenario of [
			'untouched',
			'touched',
			'undone',
			'unknown',
		] as const)
			test.effect(`resolved thread with ${scenario} history`, () =>
				Effect.gen(function* () {
					const fixture = setup()
					const thread = reviewThread(undefined, { isResolved: true })
					fixture.fake.threads.push({
						...thread,
						comments: {
							...thread.comments,
							nodes: thread.comments.nodes.map(comment => ({
								...comment,
								originalCommit: {
									oid: scenario === 'unknown' ? '0'.repeat(40) : fixture.head,
								},
							})),
						},
					})
					if (scenario === 'touched' || scenario === 'undone') {
						fixture.repo.write(
							bug().path,
							fixture.original.replace('line 10\n', 'fixed 10\n')
						)
						fixture.repo.commit()
					}
					if (scenario === 'undone') {
						fixture.repo.write(
							bug().path,
							fixture.original.replace('line 10\n', 'changed 10\n')
						)
						fixture.repo.commit()
					}
					if (scenario === 'untouched') {
						fixture.repo.write(
							bug().path,
							fixture.original
								.replace('line 10\n', 'changed 10\n')
								.replace('line 35\n', 'changed 35\n')
						)
						fixture.repo.commit()
					}
					const head = fixture.repo.git('rev-parse', 'HEAD')
					const publisher = yield* PublishService.pipe(
						Effect.provide(fixture.publisher)
					)
					expect(
						yield* publisher.publish({ ...fixture.input, head })
					).toMatchObject({
						onLine: scenario === 'untouched' ? 0 : 1,
						repeated: scenario === 'untouched' ? 1 : 0,
					})
				})
			)
		test.effect('uses a real GitService with the temporary repository', () =>
			Effect.gen(function* () {
				const fixture = setup()
				const git = yield* GitService.pipe(
					Effect.provide(gitLayer(fixture.repo.root))
				)
				expect(yield* git.resolveCommit('HEAD')).toBe(fixture.head)
			})
		)
	}
)

layer(Layer.empty, { excludeTestServices: true })(
	'PublishServiceLive batching and status',
	test => {
		test.effect(
			'batches bugs, unverified findings and nits in one review and only bugs block',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const unverified = bug({
						line: 11,
						fingerprint: 'unverified',
						placement: 'summary',
						validation: {
							status: 'unverified',
							severity: 'high',
							reason: 'No dependency contract',
							premise: 'Dependency behavior',
							model: 'validator',
							evidence: [],
						},
					})
					const nit = bug({ line: 12, fingerprint: 'nit', kind: 'nit' })
					const publisher = yield* PublishService.pipe(
						Effect.provide(fixture.publisher)
					)
					expect(
						yield* publisher.publish({
							...fixture.input,
							report: {
								...fixture.input.report,
								bugs: [bug(), unverified],
								nits: [nit],
							},
						})
					).toMatchObject({ onLine: 3, openBugs: 1, verdict: 'needs fixes' })
					const reviews = fixture.fake.writes.filter(
						call => call.method === 'review'
					)
					expect(reviews).toHaveLength(1)
					expect(
						reviews[0]?.input.comments.map(
							comment => parseFindingMarker(comment.body)?.kind
						)
					).toEqual(['bug', 'unverified', 'nit'])
				})
		)
		for (const status of [500, 503, undefined])
			test.effect(
				`review error ${status} records unposted threads without another thread write`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						fixture.fake.failures.review.push(error(status))
						const publisher = yield* PublishService.pipe(
							Effect.provide(fixture.publisher)
						)
						expect(yield* publisher.publish(fixture.input)).toMatchObject({
							unposted: 1,
							onLine: 0,
							onFile: 0,
							inSummary: 0,
						})
						expect(
							fixture.fake.writes
								.filter(
									call => call.method === 'review' || call.method === 'comment'
								)
								.map(call => call.method)
						).toEqual(['review'])
					})
			)
		test.effect(
			'uses the oldest eligible bot summary and ignores human-edited markers',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					fixture.fake.comments.push(
						{
							...summary(),
							databaseId: 1,
							author: { __typename: 'User', login: BOT_LOGIN },
						},
						{ ...summary(), databaseId: 2, editor: { login: 'contributor' } },
						{ ...summary(), databaseId: 3 },
						{ ...summary(), databaseId: 4 }
					)
					const publisher = yield* PublishService.pipe(
						Effect.provide(fixture.publisher)
					)
					yield* publisher.publish(fixture.input)
					expect(
						fixture.fake.writes
							.filter(call => call.method === 'update')
							.map(call => call.id)
					).toEqual([3])
				})
		)
		test.effect(
			'offline status leaves an existing reviewed summary unchanged',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const existing = {
						...summary(),
						body: `Verdict: ready\n${summary().body}`,
					}
					fixture.fake.comments.push(existing)
					const publisher = yield* PublishService.pipe(
						Effect.provide(fixture.publisher)
					)
					yield* publisher.publishStatus({
						pullNumber: 17,
						head: fixture.head,
						engineCommit: 'engine',
						status: 'offline',
					})
					expect(fixture.fake.writes).toEqual([])
					expect(fixture.fake.comments).toEqual([existing])
				})
		)
	}
)
