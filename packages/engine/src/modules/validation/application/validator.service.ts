import {
	type Finding,
	formatSchemaIssue,
	getValidatorChoices,
	type ReviewConfig,
	type Validation,
	verdictSchema,
} from '@mng-review/domain'
import { Context, Effect, Layer, Ref, Schema } from 'effect'
import type { Rules } from '../../../platform/config/rules.service'
import { fenceData, truncateText } from '../../../utils/fence.util'
import {
	ReadFileTool,
	DiffTool,
	VALIDATOR_REPO_TOOLS,
} from '../../review/application/repo.toolkit'
import { ReportVerdictTool } from '../../review/application/report-verdict.tool'
import { AgentLoopService } from '../../review/application/services/agent-loop.service'
import {
	type ModelCallError,
	ModelHealthService,
} from '../../review/application/services/model-health.service'
import {
	type RepoScope,
	RepoToolsService,
} from '../../review/application/services/repo-tools.service'
import type { LoopBudget } from '../../review/domain/loop-budget.helper'
import type { LoopError } from '../../review/domain/review.errors'
import { VALIDATOR_PROMPT } from './validator.prompt'

/** Attempts per finding before it is kept as unvalidated. */
export const VALIDATION_ATTEMPTS = 2
/** Characters of the finding's file the validator gets in its first message. */
const MAX_FILE_CHARS = 20_000
/** Lines before and after the finding's line the validator gets in its first message. */
const FILE_WINDOW_LINES = 150

/** The `read_file` range around a finding's line. */
function toFileWindow(line: number): string {
	return `${Math.max(1, line - FILE_WINDOW_LINES)}-${line + FILE_WINDOW_LINES}`
}
const NONE = '(none)'
const NO_MODEL_LEFT = 'no validator model left'
/** The validators' line in the run's tokens by source. */
const VALIDATOR_SOURCE = 'validator'

/** Why a validator conversation gave no verdict. */
type ValidatorFailure = LoopError | ModelCallError

/** What every validator of one run shares. */
export interface ValidatorContext {
	readonly scope: RepoScope
	readonly config: ReviewConfig
	readonly rules: Pick<Rules, 'context' | 'memory'>
	/** Tokens each validation may spend; without it only `limits.tokens_per_run` stops it. */
	readonly budget?: LoopBudget
}

/** Reads a `report_verdict` answer; the schema's reasons go back to the model. */
function parseVerdict(answer: unknown) {
	return Schema.decodeUnknownEffect(verdictSchema)(answer).pipe(
		Effect.mapError(error => ({ message: formatSchemaIssue(error.issue) }))
	)
}

/**
 * Runs one fresh agent per bug finding, told to refute it. With `validator: cross` it picks a
 * reviewer model that did not report the finding, else the same model in a fresh conversation; an
 * explicit validator comes first. Each attempt takes the first model still available. A finding with
 * no usable answer after two attempts, or once the token budget is spent, is kept as
 * `unvalidated`; validation never fails the run.
 */
export class ValidatorService extends Context.Service<
	ValidatorService,
	{
		readonly validate: (
			finding: Finding,
			context: ValidatorContext
		) => Effect.Effect<Validation>
	}
>()('mng-review/ValidatorService') {}

export const ValidatorServiceLive = Layer.effect(
	ValidatorService,
	Effect.gen(function* () {
		const loop = yield* AgentLoopService
		const health = yield* ModelHealthService
		const repoTools = yield* RepoToolsService

		const toUserMessage = Effect.fn('ValidatorService.toUserMessage')(
			function* (finding: Finding, context: ValidatorContext) {
				const { scope, rules } = context
				const [file, diff] = yield* Effect.all(
					[
						repoTools.call(scope, ReadFileTool.name, {
							ref: 'head',
							path: finding.path,
							range: toFileWindow(finding.line),
						}),
						repoTools.call(scope, DiffTool.name, { path: finding.path }),
					],
					{ concurrency: 2 }
				)
				const reported = {
					path: finding.path,
					line: finding.line,
					severity: finding.severity,
					title: finding.title,
					trigger: finding.trigger,
					impact: finding.impact,
					evidence: finding.evidence,
					...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
				}
				return [
					fenceData('The finding to check:', JSON.stringify(reported, null, 2)),
					fenceData(
						`${finding.path} at head, lines around the finding (read more with read_file):`,
						truncateText(file, MAX_FILE_CHARS)
					),
					fenceData(`Diff of ${finding.path}:`, diff),
					fenceData(
						'Repository context notes (.mng/CONTEXT.md):',
						rules.context?.trim() || NONE
					),
					fenceData(
						'Accepted intentional decisions (.mng/MEMORY.md):',
						rules.memory?.trim() || NONE
					),
				].join('\n\n')
			}
		)

		/** One fresh validator conversation on the first model still available; a loop failure is kept in `lastError`. */
		const attempt = (
			finding: Finding,
			context: ValidatorContext,
			user: string,
			lastError: Ref.Ref<ValidatorFailure | undefined>
		) =>
			Effect.gen(function* () {
				const dropped = yield* health.dropped
				const model = getValidatorChoices(finding, context.config).find(
					entry => !dropped.some(drop => drop.model === entry.model)
				)
				if (!model) return yield* Effect.fail({ message: NO_MODEL_LEFT })
				const { value } = yield* loop
					.run({
						model,
						system: VALIDATOR_PROMPT,
						user,
						scope: context.scope,
						tools: VALIDATOR_REPO_TOOLS,
						finish: ReportVerdictTool.name,
						parse: parseVerdict,
						source: VALIDATOR_SOURCE,
						...(context.budget ? { budget: context.budget } : {}),
					})
					.pipe(Effect.tapError(error => Ref.set(lastError, error)))
				const judgement = {
					severity: value.severity,
					reason: value.reason,
					evidence: value.evidence,
					model: model.model,
				}
				if (value.verdict === 'unverified')
					return {
						...judgement,
						status: 'unverified',
						premise: value.premise ?? '',
					} satisfies Validation
				return {
					...judgement,
					status: value.verdict === 'confirm' ? 'confirmed' : 'rejected',
				} satisfies Validation
			})

		const validate = Effect.fn('ValidatorService.validate')(function* (
			finding: Finding,
			context: ValidatorContext
		) {
			const user = yield* toUserMessage(finding, context)
			const lastError = yield* Ref.make<ValidatorFailure | undefined>(undefined)
			return yield* attempt(finding, context, user, lastError).pipe(
				Effect.retry({
					times: VALIDATION_ATTEMPTS - 1,
					while: error =>
						error.message !== NO_MODEL_LEFT &&
						!('_tag' in error && error._tag === 'TokenBudgetError'),
				}),
				Effect.catch(error =>
					Ref.get(lastError).pipe(
						Effect.map((last): Validation => ({
							status: 'unvalidated',
							error: last?.message ?? error.message,
							...(last?._tag === 'TokenBudgetError'
								? { budgetSpent: true }
								: {}),
						}))
					)
				)
			)
		})

		return { validate }
	})
)
