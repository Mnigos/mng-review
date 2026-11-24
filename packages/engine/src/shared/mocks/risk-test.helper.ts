import {
	applyFileSkips,
	buildPlan,
	type Plan,
	type ReviewConfig,
} from '@mng-review/domain'
import { Effect, Layer } from 'effect'
import { ReviewLimits } from '../../modules/review/application/review-limits.context'
import { toEmptyReviewReport } from '../../modules/review/domain/review-report.helper'
import {
	RaterService,
	type RateRequest,
} from '../../modules/risk/application/rater.service'
import { RaterPipelineLive } from '../../modules/risk/infrastructure/risk.layers'
import { GitService } from '../../platform/git/git.service'
import {
	makeScriptedLlmLayer,
	ScriptedLlm,
	type ScriptedLlmAnswer,
} from '../../platform/llm/scripted-llm.layer'
import { TokenLedgerLive } from '../../platform/llm/token-ledger.service'
import { config, NORMAL_ROUTER, pr } from './domain-test.helper'
import { createRepo, gitLayer } from './git-test.helper'
import { answer, LIMITS } from './review-test.helper'

export const RISK_ANSWER = {
	level: 'low',
	reasons: ['The change is local.'],
	refs: [],
} as const

/** A committed local change used by both the rater and floor reader. */
export function riskRepo(path = 'src/value.ts', content = 'after\n') {
	const repo = createRepo()
	repo.write('README.md', 'fixture\n')
	const base = repo.commit()
	repo.write(path, content)
	const head = repo.commit()
	return { ...repo, base, head }
}

export interface RiskTestOptions {
	readonly config?: ReviewConfig
	readonly script?: ScriptedLlmAnswer
	readonly review?: Partial<RateRequest['review']>
	readonly router?: Plan['router']
	readonly rules?: RateRequest['rules']['risk']
	readonly pr?: RateRequest['pr']
	readonly previous?: RateRequest['previous']
}

/** Runs the real rater loop and tools over local git and a scripted model, retaining every request. */
export function rateRepo(
	repo: ReturnType<typeof riskRepo>,
	options: RiskTestOptions = {}
) {
	const cfg =
		options.config ?? config({ risk: { ...config().risk, enabled: true } })
	const scripted = makeScriptedLlmLayer(
		options.script ?? (() => Effect.succeed(answer('report_risk', RISK_ANSWER)))
	)
	const services = RaterPipelineLive.pipe(
		Layer.provideMerge(scripted),
		Layer.provideMerge(TokenLedgerLive),
		Layer.provide(
			Layer.succeed(ReviewLimits, {
				...LIMITS,
				tokensPerRun: cfg.limits.tokens_per_run,
				maxToolCalls: 50,
				maxWallTime: '1 minute',
			})
		),
		Layer.provideMerge(gitLayer(repo.root))
	)
	return Effect.gen(function* () {
		const git = yield* GitService
		const raw = yield* git.readChange(repo.base, repo.head)
		const change = { ...raw, files: applyFileSkips(raw.files, cfg) }
		const metadata = options.pr ?? pr()
		const plan = buildPlan(
			{ config: cfg, agents: [], files: change.files, pr: metadata },
			options.router ?? NORMAL_ROUTER
		)
		const review = {
			...toEmptyReviewReport(
				{ change, plan, rulesSource: repo.base, tokens: {} },
				0
			),
			...options.review,
		}
		const rating = yield* RaterService.use(service =>
			service.rate({
				rules: {
					config: cfg,
					agents: [],
					source: repo.base,
					...(options.rules ? { risk: options.rules } : {}),
				},
				change,
				plan,
				review,
				pr: metadata,
				...(options.previous ? { previous: options.previous } : {}),
			})
		)
		return {
			rating,
			calls: yield* ScriptedLlm.use(model => model.calls),
			change,
		}
	}).pipe(Effect.provide(services))
}
