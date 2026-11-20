import { join } from 'node:path'
import { RulesService } from '@mng-review/engine'
import {
	GitHubWriteConfigLive,
	PublishServiceLive,
	StatusReportServiceLive,
	SummaryCommentServiceLive,
	ThreadResolutionServiceLive,
} from '@mng-review/github'
import { ConfigProvider, Effect, Layer } from 'effect'
// oxlint-disable-next-line no-restricted-imports -- The test brief requires these existing unexported GitHub fixtures.
import { githubApiFake } from '../../../../../packages/github/src/shared/mocks/github-api-fake.helper'
// oxlint-disable-next-line no-restricted-imports -- The test brief requires these existing unexported GitHub fixtures.
import { githubStatusFake } from '../../../../../packages/github/src/shared/mocks/github-status-fake.helper'
import { PublishRunServiceLive } from '../../application/publish-run.service'
import { createRepo, gitLayer } from './git-test.helper'
import {
	BINDING_ENV,
	outcomeFile,
	boundReviewReport,
} from './outcome-file.helper'
import { eventPayload } from './pull-request-event.helper'
import { RULES } from './review-report.helper'

/** Local repository and runner files with recording GitHub boundaries and no HTTP layer. */
export function stepFixture() {
	const repo = createRepo()
	repo.write('src/items/store.ts', 'first\nold value\nlast\n')
	const base = repo.commit()
	repo.write('src/items/store.ts', 'first\nnew value\nlast\n')
	const head = repo.commit()
	const payload = eventPayload()
	const event = {
		...payload,
		pull_request: {
			...payload.pull_request,
			base: { ...payload.pull_request.base, sha: base },
			head: { ...payload.pull_request.head, sha: head },
		},
	}
	repo.write('event.json', JSON.stringify(event))
	const paths = {
		prepared: join(repo.root, 'prepared.json'),
		outcome: join(repo.root, 'outcome.json'),
		result: join(repo.root, 'result.json'),
		summary: join(repo.root, 'summary.md'),
		output: join(repo.root, 'output.txt'),
	} as const
	const environment = {
		GITHUB_EVENT_NAME: 'pull_request_target',
		GITHUB_EVENT_PATH: join(repo.root, 'event.json'),
		GITHUB_REPOSITORY: BINDING_ENV.repository,
		GITHUB_RUN_ID: BINDING_ENV.runId,
		GITHUB_RUN_ATTEMPT: BINDING_ENV.runAttempt,
		MNG_REVIEW_ENGINE_COMMIT: BINDING_ENV.engineCommit,
		MNG_REVIEW_PREPARED_PATH: paths.prepared,
		MNG_REVIEW_OUTCOME_PATH: paths.outcome,
		MNG_REVIEW_RESULT_PATH: paths.result,
		GITHUB_STEP_SUMMARY: paths.summary,
		GITHUB_OUTPUT: paths.output,
	} as const
	const envLayer = (overrides: Readonly<Record<string, string>> = {}) =>
		ConfigProvider.layer(
			ConfigProvider.fromEnvRecord({ ...environment, ...overrides })
		)
	const file = outcomeFile()
	const sourceReport = boundReviewReport()
	const report = {
		...sourceReport,
		planReport: {
			...sourceReport.planReport,
			change: {
				...sourceReport.planReport.change,
				base: { ref: 'main', commit: base },
				head: { ref: 'HEAD', commit: head },
				mergeBase: base,
			},
		},
	}
	const boundFile = {
		...file,
		report,
		binding: { ...file.binding, baseSha: base, headSha: head },
	}
	const rules = { ...RULES, source: base }
	const loads: (string | undefined)[] = []
	const load = (source: string | undefined) =>
		Effect.sync(() => {
			loads.push(source)
			return rules
		})
	const rulesLayer = Layer.succeed(RulesService, { load })
	const api = githubApiFake()
	const status = githubStatusFake()
	const publisherLayer = PublishServiceLive.pipe(
		Layer.provideMerge(SummaryCommentServiceLive),
		Layer.provideMerge(
			Layer.mergeAll(
				api.api,
				ThreadResolutionServiceLive.pipe(Layer.provide(api.api)),
				GitHubWriteConfigLive.pipe(
					Layer.provide(envLayer({ GITHUB_TOKEN: 'fixture-token' }))
				),
				gitLayer(repo.root)
			)
		)
	)
	const publishRunLayer = PublishRunServiceLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				publisherLayer,
				StatusReportServiceLive.pipe(Layer.provide(status.layer)),
				rulesLayer
			)
		)
	)
	return {
		repo,
		base,
		head,
		paths,
		environment,
		envLayer,
		file: boundFile,
		report,
		rules,
		rulesLayer,
		loads,
		api,
		status,
		publisherLayer,
		publishRunLayer,
	}
}
