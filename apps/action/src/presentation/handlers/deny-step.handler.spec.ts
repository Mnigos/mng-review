import { layer } from '@effect/vitest'
import {
	AnswerReadService,
	CommandAnswerServiceLive,
	GitHubApiError,
	parseAnswerMarker,
	toAnsweredComment,
} from '@mng-review/github'
import { Effect, Layer } from 'effect'
import {
	cleanupRepos,
	FileSystemLayer,
} from '../../shared/mocks/git-test.helper'
import { stepFixture } from '../../shared/mocks/step-test.helper'
import { FAILED_EXIT_CODE } from '../action-exit.errors'
import { runDenyStep } from './deny-step.handler'

/** The refusal kinds the denial job posts. */
type RefusalKind = 'deny' | 'cap'

/** A step fixture holding a writer's comment 23 at `body`, edited at `at`. */
function denyFixture(body: string, at: string) {
	const fixture = stepFixture([], true)
	fixture.api.comments.push({
		id: 'comment-23',
		databaseId: 23,
		isMinimized: false,
		body,
		createdAt: '2026-01-01T12:00:00Z',
		lastEditedAt: at,
		author: { __typename: 'User', login: 'writer' },
		editor: null,
	})
	return fixture
}

/** `runDenyStep` for comment 23 on pull request 17 with the given refusal kind. */
function runDeny(fixture: ReturnType<typeof stepFixture>, kind: RefusalKind) {
	const answers = Layer.succeed(AnswerReadService, {
		readCommands: () => Effect.die('unused'),
		getCommandEntry: () => Effect.die('unused'),
		getCountedReviews: () => Effect.die('unused'),
	})
	return runDenyStep.pipe(
		Effect.provide(
			CommandAnswerServiceLive.pipe(
				Layer.provideMerge(answers),
				Layer.provideMerge(fixture.publisherLayer)
			)
		),
		Effect.provide(fixture.rulesLayer),
		Effect.provide(
			fixture.envLayer({
				MNG_REVIEW_TARGET_PR: '17',
				MNG_REVIEW_ANSWER_COMMENT: '23',
				MNG_REVIEW_ANSWER_KIND: kind,
				MNG_REVIEW_ANSWER_REASON: 'refused',
				GITHUB_RUN_ID: '7',
			})
		)
	)
}

afterEach(cleanupRepos)

layer(FileSystemLayer)('deny step', test => {
	for (const kind of ['deny', 'cap'] as const)
		for (const commandPresent of [false, true])
			test.effect(
				`${kind} posts a new current-version answer only while command present=${commandPresent}`,
				() =>
					Effect.gen(function* () {
						const version = {
							id: 23,
							at: '2026-01-02T12:00:00Z',
							body: commandPresent
								? '@mng-review review deep'
								: 'command removed',
						}
						const fixture = denyFixture(version.body, version.at)
						yield* runDeny(fixture, kind)
						expect(fixture.api.writes).toHaveLength(commandPresent ? 1 : 0)
						const [write] = fixture.api.writes
						if (commandPresent) {
							expect(write?.method).toBe('create')
							if (write?.method !== 'create') return
							expect(parseAnswerMarker(write.body)?.answers).toEqual([
								{ run: 7, kind, ids: [toAnsweredComment(version)] },
							])
						}
					})
			)
	for (const kind of ['deny', 'cap'] as const)
		for (const failing of ['listComments', 'create'] as const)
			test.effect(
				`a failed ${failing} fails the ${kind} step so the command is not left unanswered`,
				() =>
					Effect.gen(function* () {
						const fixture = denyFixture(
							'@mng-review review deep',
							'2026-01-02T12:00:00Z'
						)
						fixture.api.failures[failing].push(
							new GitHubApiError({
								operation: failing,
								reason: 'unavailable',
								status: 503,
							})
						)
						const error = yield* Effect.flip(runDeny(fixture, kind))
						expect(error._tag).toBe('ActionExit')
						if (error._tag !== 'ActionExit') return
						expect(error.code).toBe(FAILED_EXIT_CODE)
					})
			)
})
