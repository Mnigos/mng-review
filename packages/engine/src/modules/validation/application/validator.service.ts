import {
	absorb,
	CONTEXT_PATH,
	type Finding,
	formatSchemaIssue,
	getEvidencePaths,
	getNearGroups,
	getValidatorChoices,
	isNearDuplicate,
	MEMORY_PATH,
	type ReviewConfig,
	toConfirmedEdit,
	toValidation,
	type Validation,
	type Verdict,
	verdictSchema,
} from '@mng-review/domain'
import { Context, Effect, Layer, Ref, Schema } from 'effect'
import type { Rules } from '../../../platform/config/rules.service'
import { GitService } from '../../../platform/git/git.service'
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

/**
 * The rule files whose text the validator got in its first message; citing one counts as
 * repository evidence. An empty or missing rule file is looked up in git like any other path.
 */
function getSuppliedRuleFiles(rules: ValidatorContext['rules']): string[] {
	return [
		...(rules.context?.trim() ? [CONTEXT_PATH] : []),
		...(rules.memory?.trim() ? [MEMORY_PATH] : []),
	]
}

/** Why a validator conversation gave no verdict. */
type ValidatorFailure = LoopError | ModelCallError

/** What every validator of one run shares. */
export interface ValidatorContext {
	readonly scope: RepoScope
	readonly config: ReviewConfig
	readonly rules: Pick<Rules, 'context' | 'memory'>
	/** Tokens each validation may spend; without it only `limits.tokens_per_run` stops it. */
	readonly budget?: LoopBudget
	/** Other finders' reports near this finding; the validator names those with its root cause. */
	readonly nearby?: readonly Finding[]
}

/** A validation and the nearby findings (by index) the validator judged to be the same defect. */
interface Judged {
	readonly validation: Validation
	readonly sameAs: readonly number[]
}

/** A finding and the near duplicates merged into it. */
interface Merged {
	readonly finding: Finding
	readonly absorbed: readonly Finding[]
}

/** Validated bugs, near duplicates the validator judged to be one defect merged; index by index. */
export interface ValidatedBugs {
	readonly bugs: readonly Finding[]
	readonly validations: readonly Validation[]
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
		readonly validateAll: (
			bugs: readonly Finding[],
			context: ValidatorContext
		) => Effect.Effect<ValidatedBugs>
	}
>()('mng-review/ValidatorService') {}

export const ValidatorServiceLive = Layer.effect(
	ValidatorService,
	Effect.gen(function* () {
		const loop = yield* AgentLoopService
		const health = yield* ModelHealthService
		const repoTools = yield* RepoToolsService
		const git = yield* GitService

		/**
		 * True when an evidence entry names a rule file the validator was given or a file at the head or
		 * the merge base. A git failure counts as no evidence, which keeps the finding.
		 */
		const hasRepositoryEvidence = Effect.fn(
			'ValidatorService.hasRepositoryEvidence'
		)(function* (verdict: Verdict, context: ValidatorContext) {
			const paths = getEvidencePaths(verdict.evidence)
			const supplied = getSuppliedRuleFiles(context.rules)
			if (paths.some(path => supplied.includes(path))) return true
			if (paths.length === 0) return false
			const { change } = context.scope
			const [head, base] = yield* Effect.all(
				[
					git.getFilesAt(change.head.commit, paths),
					git.getFilesAt(change.mergeBase, paths),
				],
				{ concurrency: 2 }
			).pipe(
				Effect.orElseSucceed((): readonly ReadonlySet<string>[] => [
					new Set(),
					new Set(),
				])
			)
			return head.size + base.size > 0
		})

		/**
		 * The answer's fix when `toConfirmedEdit` accepts it against the finding's file at the head; a
		 * git failure leaves it out, and the finding keeps its confirmation.
		 */
		const getConfirmedEdit = Effect.fn('ValidatorService.getConfirmedEdit')(
			function* (verdict: Verdict, finding: Finding, scope: RepoScope) {
				if (verdict.verdict !== 'confirm' || !verdict.edit) return undefined
				const { commit } = scope.change.head
				const headText = yield* git
					.readFileAt(commit, finding.path)
					.pipe(Effect.orElseSucceed(() => undefined))
				return toConfirmedEdit({
					verdict,
					line: finding.line,
					commit,
					headText,
				})
			}
		)

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
				const nearby = (context.nearby ?? []).map((other, index) => ({
					number: index + 1,
					line: other.line,
					title: other.title,
					trigger: other.trigger,
					impact: other.impact,
				}))
				return [
					fenceData('The finding to check:', JSON.stringify(reported, null, 2)),
					...(nearby.length > 0
						? [
								fenceData(
									`Nearby findings from other reviewers in ${finding.path}:`,
									JSON.stringify(nearby, null, 2)
								),
							]
						: []),
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
				const edit = yield* getConfirmedEdit(value, finding, context.scope)
				const validation = toValidation({
					verdict: value,
					reported: finding.severity,
					model: model.model,
					hasRepositoryEvidence:
						value.verdict !== 'reject' ||
						(yield* hasRepositoryEvidence(value, context)),
					...(edit ? { edit } : {}),
				})
				return {
					validation,
					// A rejection merges nothing, even one kept as unverified for want of evidence.
					sameAs:
						value.verdict === 'reject'
							? []
							: (value.same_root_cause ?? []).map(number => number - 1),
				} satisfies Judged
			})

		const judge = Effect.fn('ValidatorService.judge')(function* (
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
						Effect.map((last): Judged => ({
							validation: {
								status: 'unvalidated',
								error: last?.message ?? error.message,
								...(last?._tag === 'TokenBudgetError'
									? { budgetSpent: true }
									: {}),
							},
							sameAs: [],
						}))
					)
				)
			)
		})

		const validate = (finding: Finding, context: ValidatorContext) =>
			judge(finding, context).pipe(Effect.map(judged => judged.validation))

		/**
		 * Validates one group of near duplicates in order: the first is validated with the others as
		 * nearby findings, the ones its validator names as the same defect merge into it unvalidated,
		 * and the rest go on the same way. A rejected or unvalidated finding merges nothing.
		 */
		const validateGroup = (
			group: readonly Finding[],
			context: ValidatorContext
		): Effect.Effect<readonly (readonly [Finding, Validation])[]> =>
			Effect.gen(function* () {
				const [first, ...rest] = group
				if (!first) return []
				const nearby = rest.filter(other => isNearDuplicate(first, other))
				const { validation, sameAs } = yield* judge(first, {
					...context,
					nearby,
				})
				const kept =
					validation.status === 'confirmed' ||
					validation.status === 'unverified'
				const named = kept
					? nearby.filter((_, index) => sameAs.includes(index))
					: []
				const merged = named.reduce<Merged>(
					(state, other) =>
						isNearDuplicate(state.finding, other)
							? {
									finding: absorb(state.finding, other),
									absorbed: [...state.absorbed, other],
								}
							: state,
					{ finding: first, absorbed: [] }
				)
				const left = rest.filter(other => !merged.absorbed.includes(other))
				return [
					[merged.finding, validation] as const,
					...(yield* validateGroup(left, context)),
				]
			})

		const validateAll = Effect.fn('ValidatorService.validateAll')(function* (
			bugs: readonly Finding[],
			context: ValidatorContext
		) {
			const groups = yield* Effect.forEach(
				getNearGroups(bugs),
				group => validateGroup(group, context),
				{ concurrency: 'unbounded' }
			)
			const pairs = groups.flat()
			return {
				bugs: pairs.map(([bug]) => bug),
				validations: pairs.map(([, validation]) => validation),
			} satisfies ValidatedBugs
		})

		return { validate, validateAll }
	})
)
