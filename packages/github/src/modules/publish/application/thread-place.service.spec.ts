import { layer } from '@effect/vitest'
import { GitService } from '@mng-review/engine'
import { Effect, Layer } from 'effect'
import {
	cleanupRepos,
	createRepo,
	gitLayer,
} from '../../../shared/mocks/git-test.helper'
import {
	botThread,
	bug,
	report,
	RULES,
} from '../../../shared/mocks/publish-test.helper'
import { THREAD_PLACE_LINES } from '../domain/publish.constants'
import {
	ThreadPlaceService,
	ThreadPlaceServiceLive,
} from './thread-place.service'

/** Local history changes the finding before closure, then leaves room for a later commit. */
function setup() {
	const repo = createRepo()
	const original = `${Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n')}\n`
	repo.write(bug().path, original)
	const commit = repo.commit()
	const closedText = original.replace('line 10\n', 'accepted 10\n')
	repo.write(bug().path, closedText)
	const closedAt = repo.commit()
	return { repo, commit, closedText, closedAt }
}

afterEach(cleanupRepos)

layer(Layer.empty, { excludeTestServices: true })(
	'ThreadPlaceService closed threads',
	test => {
		for (const changed of [false, true])
			test.effect(
				`uses the closing commit for git log, changed after closure=${changed}`,
				() =>
					Effect.gen(function* () {
						const fixture = setup()
						fixture.repo.write(
							bug().path,
							fixture.closedText.replace(
								changed ? 'accepted 10\n' : 'line 35\n',
								changed ? 'changed again 10\n' : 'changed 35\n'
							)
						)
						const head = fixture.repo.commit()
						const git = yield* GitService.pipe(
							Effect.provide(gitLayer(fixture.repo.root))
						)
						const execSpy = vi.spyOn(git, 'exec')
						expect(
							yield* ThreadPlaceService.use(service =>
								service.getChangedPlaces(
									{ report: report(), rules: RULES, head },
									[
										botThread({
											resolved: true,
											commit: fixture.commit,
											closedAt: fixture.closedAt,
										}),
									]
								)
							).pipe(
								Effect.provide(
									ThreadPlaceServiceLive.pipe(
										Layer.provide(Layer.succeed(GitService, git))
									)
								)
							)
						).toEqual(new Set(changed ? ['thread'] : []))
						expect(execSpy).toHaveBeenCalledExactlyOnceWith([
							'log',
							'--no-ext-diff',
							'--no-textconv',
							'--no-color',
							'--format=mng-review-commit:%H',
							`-L${bug().line - THREAD_PLACE_LINES},${bug().line + THREAD_PLACE_LINES}:${bug().path}`,
							`${fixture.closedAt}..${head}`,
						])
					})
			)
		test.effect(
			'a closing commit equal to head is unchanged without reading git',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const git = yield* GitService.pipe(
						Effect.provide(gitLayer(fixture.repo.root))
					)
					const execSpy = vi.spyOn(git, 'exec')
					const readFileAtSpy = vi.spyOn(git, 'readFileAt')
					expect(
						yield* ThreadPlaceService.use(service =>
							service.getChangedPlaces(
								{ report: report(), rules: RULES, head: fixture.closedAt },
								[
									botThread({
										resolved: true,
										commit: fixture.commit,
										closedAt: fixture.closedAt,
									}),
								]
							)
						).pipe(
							Effect.provide(
								ThreadPlaceServiceLive.pipe(
									Layer.provide(Layer.succeed(GitService, git))
								)
							)
						)
					).toEqual(new Set())
					expect(execSpy).not.toHaveBeenCalled()
					expect(readFileAtSpy).not.toHaveBeenCalled()
				})
		)
		test.effect(
			'a thread without a closing commit still counts changes since its original commit',
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					expect(
						yield* ThreadPlaceService.use(service =>
							service.getChangedPlaces(
								{ report: report(), rules: RULES, head: fixture.closedAt },
								[botThread({ resolved: true, commit: fixture.commit })]
							)
						).pipe(
							Effect.provide(
								ThreadPlaceServiceLive.pipe(
									Layer.provide(gitLayer(fixture.repo.root))
								)
							)
						)
					).toEqual(new Set(['thread']))
				})
		)
	}
)
