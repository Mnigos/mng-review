import {
	type Finding,
	formatSchemaIssue,
	getValidatorChoices,
	type ReviewConfig,
	type Validation,
	verdictSchema,
} from '@mng-review/domain'
import { Context, Effect, Layer, Schema } from 'effect'
import type { Rules } from '../../../platform/config/rules.service'
import { fenceData, truncateText } from '../../../utils/fence.util'
import {
	ReadFileTool,
	DiffTool,
	VALIDATOR_REPO_TOOLS,
} from '../../review/application/repo.toolkit'
import { ReportVerdictTool } from '../../review/application/report-verdict.tool'
import { AgentLoopService } from '../../review/application/services/agent-loop.service'
import { ModelHealthService } from '../../review/application/services/model-health.service'
import {
	type RepoScope,
	RepoToolsService,
} from '../../review/application/services/repo-tools.service'
import { VALIDATOR_PROMPT } from './validator.prompt'

/** Attempts per finding before it is kept as unvalidated. */
export const VALIDATION_ATTEMPTS = 2
/** Characters of the finding's file the validator gets in its first message. */
const MAX_FILE_CHARS = 40_000
const NONE = '(none)'
const NO_MODEL_LEFT = 'no validator model left'

/** What every validator of one run shares. */
export interface ValidatorContext {
	readonly scope: RepoScope
	readonly config: ReviewConfig
	readonly rules: Pick<Rules, 'context' | 'memory'>
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
 * no usable answer after two attempts is kept as `unvalidated`; validation never fails the run.
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
						`${finding.path} at head:`,
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

		const attempt = (
			finding: Finding,
			context: ValidatorContext,
			user: string,
			left: number,
			lastError: string
		): Effect.Effect<Validation> =>
			Effect.gen(function* () {
				if (left === 0) return { status: 'unvalidated', error: lastError }
				const dropped = yield* health.dropped
				const model = getValidatorChoices(finding, context.config).find(
					entry => !dropped.some(drop => drop.model === entry.model)
				)
				if (!model)
					return { status: 'unvalidated', error: lastError || NO_MODEL_LEFT }
				return yield* loop
					.run({
						model,
						system: VALIDATOR_PROMPT,
						user,
						scope: context.scope,
						tools: VALIDATOR_REPO_TOOLS,
						finish: ReportVerdictTool.name,
						parse: parseVerdict,
					})
					.pipe(
						Effect.map(({ value }): Validation => ({
							status: value.verdict === 'confirm' ? 'confirmed' : 'rejected',
							severity: value.severity,
							reason: value.reason,
							evidence: value.evidence,
							model: model.model,
						})),
						Effect.catch(error =>
							attempt(finding, context, user, left - 1, error.message)
						)
					)
			})

		const validate = Effect.fn('ValidatorService.validate')(function* (
			finding: Finding,
			context: ValidatorContext
		) {
			const user = yield* toUserMessage(finding, context)
			return yield* attempt(finding, context, user, VALIDATION_ATTEMPTS, '')
		})

		return { validate }
	})
)
