import { Layer } from 'effect'
import { PublishServiceLive } from '../../modules/publish/application/publish.service'
import type { PublishInput } from '../../modules/publish/application/publish.service.types'
import { ReplyPublishServiceLive } from '../../modules/publish/application/reply-publish.service'
import { SummaryReviewServiceLive } from '../../modules/publish/application/summary-review.service'
import { ThreadResolutionServiceLive } from '../../modules/publish/application/thread-resolution.service'
import type { BotIdentity } from '../../platform/bot-identity.helper'
import { GitHubConfig } from '../../platform/github.config'
import { createRepo, gitLayer } from './git-test.helper'
import { githubApiFake } from './github-api-fake.helper'
import { GITHUB_SETTINGS } from './github-http.helper'
import { githubStatusFake } from './github-status-fake.helper'
import { agentReport, APP_IDENTITY, report, RULES } from './publish-test.helper'

/** Local history and recording services for event tests; no endpoint or transport layer. */
export function publishEventFixture(identity: BotIdentity = APP_IDENTITY) {
	const repo = createRepo()
	const original = `${Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n')}\n`
	repo.write('src/store.ts', original)
	const base = repo.commit()
	repo.write('src/store.ts', original.replace('line 10\n', 'changed 10\n'))
	const head = repo.commit()
	const fake = githubApiFake(identity)
	fake.command.pullRequest = {
		...fake.command.pullRequest,
		head: { ...fake.command.pullRequest.head, sha: head },
	}
	const status = githubStatusFake()
	const dependencies = Layer.mergeAll(
		fake.api,
		status.layer,
		gitLayer(repo.root),
		Layer.succeed(GitHubConfig, { ...GITHUB_SETTINGS, identity })
	)
	const summary = SummaryReviewServiceLive.pipe(Layer.provide(dependencies))
	const publisher = PublishServiceLive.pipe(
		Layer.provide(summary),
		Layer.provide(ThreadResolutionServiceLive.pipe(Layer.provide(fake.api))),
		Layer.provide(dependencies)
	)
	const replyPublisher = ReplyPublishServiceLive.pipe(
		Layer.provide(summary),
		Layer.provide(dependencies)
	)
	const reviewed = report()
	const input = {
		pullNumber: 17,
		head,
		engineCommit: 'engine',
		rules: RULES,
		report: {
			...reviewed,
			bugs: [],
			// Every planned finder reported `ok`, so a clean run covers the change.
			agents: reviewed.planReport.plan.runs.map(run => ({
				...agentReport(),
				name: run.name,
			})),
			planReport: {
				...reviewed.planReport,
				change: {
					base: { ref: 'main', commit: base },
					head: { ref: 'HEAD', commit: head },
					mergeBase: base,
					files: [
						{
							path: 'src/store.ts',
							status: 'modified',
							additions: 1,
							deletions: 1,
							binary: false,
							sizeBytes: original.length,
						},
					],
				},
			},
		},
	} as const satisfies PublishInput
	return { repo, base, head, fake, status, publisher, replyPublisher, input }
}
