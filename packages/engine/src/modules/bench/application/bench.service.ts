import {
	type BenchCase,
	ConfigError,
	getBenchCases,
	parseBenchFile,
	type PullRequestInfo,
	toBenchFinding,
	toBenchTotals,
	toCaseScore,
} from '@mng-review/domain'
import { Clock, Context, Effect, FileSystem, Layer, Path } from 'effect'
import {
	type Rules,
	RulesService,
} from '../../../platform/config/rules.service'
import type { GitError } from '../../../platform/git/git.errors'
import { GitWorkdir } from '../../../platform/git/git.service'
import {
	type TokenLedger,
	TokenLedgerLive,
} from '../../../platform/llm/token-ledger.service'
import { reviewChange } from '../../review/application/services/review-run.service'
import { toTokenTotals } from '../domain/bench-report.helper'
import type { BenchReport, CaseReport } from '../domain/bench-report.types'

/** What `mng-review bench` is asked to run. */
export interface BenchRequest {
	/** The benchmark file, relative to the directory git runs in. */
	readonly file: string
	/** Read `.mng/` from this ref instead of the working tree. */
	readonly rulesRef?: string
	/** Run only these cases; every case when empty. */
	readonly caseIds: readonly string[]
	readonly lineWindow: number
	/** Cases reviewed at once. */
	readonly concurrency: number
}

/** What reviewing one case needs. */
interface CaseInput {
	readonly rules: Rules
	readonly entry: BenchCase
	readonly lineWindow: number
}

/**
 * A local run on a recorded change: no draft, no fork, started by a person, with the case's labels
 * and its title and description when the file gives them.
 */
function toCasePullRequest(entry: BenchCase): PullRequestInfo {
	return {
		labels: entry.labels,
		draft: false,
		fork: false,
		trigger: 'manual',
		...(entry.title ? { title: entry.title } : {}),
		...(entry.body ? { body: entry.body } : {}),
	}
}

/**
 * Plans and reviews one recorded change from git by its `base` and `head`, as `mng-review --base`
 * does, then scores the kept bugs against the case's expected entries. Nothing is checked out.
 */
const reviewCase = Effect.fn('BenchService.reviewCase')(function* (
	input: CaseInput
) {
	const { rules, entry, lineWindow } = input
	const report = yield* reviewChange({
		rules,
		baseRef: entry.base,
		headRef: entry.head,
		pr: toCasePullRequest(entry),
	})
	const { plan } = report.planReport
	return {
		id: entry.id,
		base: entry.base,
		head: entry.head,
		score: toCaseScore({
			expected: entry.expected,
			findings: report.bugs.map(toBenchFinding),
			lineWindow,
		}),
		depth: { level: plan.depth, source: plan.depthSource },
		risk: plan.risk,
		rejected: report.rejected.map(finding => ({
			path: finding.path,
			line: finding.line,
			title: finding.title,
			severity: finding.severity,
			reason: finding.reason,
			validatedBy: finding.validatedBy,
		})),
		nits: report.nits.length,
		tokens: report.tokens,
		tokenSources: report.tokenSources,
		agents: report.agents.map(agent => ({
			name: agent.name,
			model: agent.model,
			status: agent.status,
			toolCalls: agent.toolCalls,
			findings: agent.findings,
			...(agent.units === undefined ? {} : { units: agent.units }),
			...(agent.continued === undefined ? {} : { continued: agent.continued }),
			...(agent.unfinished === undefined
				? {}
				: { unfinished: agent.unfinished }),
		})),
		wallMillis: report.wallMillis,
		...(plan.skippedRun ? { skipped: plan.skippedRun } : {}),
		...(report.endpointError ? { endpointError: report.endpointError } : {}),
		...(report.incomplete ? { incomplete: report.incomplete.unfinished } : {}),
	} satisfies CaseReport
})

/** Services a case review takes from the CLI: git, the HTTP client, the environment. */
type CaseServices = Exclude<
	Effect.Services<ReturnType<typeof reviewCase>>,
	TokenLedger
>

/**
 * Replays the recorded changes of a benchmark file against the rules of the working tree or a
 * rules ref, and compares the kept bugs of each case with its expected entries. Each case has its
 * own token ledger and model health.
 */
export class BenchService extends Context.Service<
	BenchService,
	{
		readonly run: (
			request: BenchRequest
		) => Effect.Effect<BenchReport, ConfigError | GitError>
	}
>()('mng-review/BenchService') {}

export const BenchServiceLive = Layer.effect(
	BenchService,
	Effect.gen(function* () {
		const rulesService = yield* RulesService
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const workdir = yield* GitWorkdir
		const caseServices = yield* Effect.context<CaseServices>()

		const readBenchFile = (file: string) =>
			fs.readFileString(path.resolve(workdir.cwd, file)).pipe(
				Effect.mapError(
					error =>
						new ConfigError({
							source: file,
							reason: `cannot be read (${error.message})`,
						})
				),
				Effect.flatMap(text => parseBenchFile(text, file))
			)

		const run = Effect.fn('BenchService.run')(function* (
			request: BenchRequest
		) {
			const startedAt = yield* Clock.currentTimeMillis
			const file = yield* readBenchFile(request.file)
			const entries = yield* getBenchCases(file, request.caseIds, request.file)
			const rules = yield* rulesService.load(request.rulesRef)
			const cases = yield* Effect.forEach(
				entries,
				entry =>
					reviewCase({ rules, entry, lineWindow: request.lineWindow }).pipe(
						// A plain provide reuses the memoized ledger, so every case would share one budget.
						Effect.provide(Layer.fresh(TokenLedgerLive)),
						Effect.provideContext(caseServices)
					),
				{ concurrency: request.concurrency }
			)
			return {
				file: request.file,
				rulesSource: rules.source,
				lineWindow: request.lineWindow,
				cases,
				totals: toBenchTotals(cases),
				tokens: toTokenTotals(cases.map(entry => entry.tokens)),
				wallMillis: (yield* Clock.currentTimeMillis) - startedAt,
			} satisfies BenchReport
		})

		return { run }
	})
)
