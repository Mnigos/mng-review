import { layer } from '@effect/vitest'
import { TokenLedgerLive } from '@mng-review/engine'
import { ConfigProvider, Effect, Layer } from 'effect'
import { HttpClient } from 'effect/http'
import { pr } from '../../../shared/mocks/domain-test.helper'
import {
	cleanupRepos,
	createRepo,
	gitLayer,
} from '../../../shared/mocks/git-test.helper'
import { RULES } from '../../../shared/mocks/publish-test.helper'
import {
	pendingBotThread,
	pendingReply,
} from '../../../shared/mocks/thread-reply-test.helper'
import {
	ReplyDecisionService,
	ReplyDecisionServiceLive,
} from './reply-decision.service'

afterEach(cleanupRepos)

layer(Layer.empty, { excludeTestServices: true })(
	'ReplyDecisionService without endpoint',
	test => {
		test.effect(
			'returns undefined without requesting HTTP or invoking a model',
			() =>
				Effect.gen(function* () {
					const repo = createRepo()
					const httpSpy = vi.fn(() => Effect.die('unexpected HTTP request'))
					const dependencies = Layer.mergeAll(
						gitLayer(repo.root),
						TokenLedgerLive,
						Layer.succeed(HttpClient.HttpClient, HttpClient.make(httpSpy))
					)
					expect(
						yield* ReplyDecisionService.use(service =>
							service.decide({
								rules: RULES,
								pr: pr(),
								head: 'b'.repeat(40),
								mergeBase: 'a'.repeat(40),
								replies: [pendingReply()],
								threads: [pendingBotThread({ commit: 'a'.repeat(40) })],
							})
						).pipe(
							Effect.provide(
								ReplyDecisionServiceLive.pipe(Layer.provide(dependencies))
							),
							Effect.provide(
								ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))
							)
						)
					).toBeUndefined()
					expect(httpSpy).not.toHaveBeenCalled()
				})
		)
	}
)
