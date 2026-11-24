import { parseRiskDescription, type RiskDescription } from '@mng-review/domain'
import { REFUSAL_KINDS } from '@mng-review/github'
import { Config, Option } from 'effect'

export const APP_ENVIRONMENT_VARIABLE = 'MNG_REVIEW_APP_ENVIRONMENT'
export const DEFAULT_BRANCH_VARIABLE = 'MNG_REVIEW_DEFAULT_BRANCH'
export const RISK_DESCRIPTION_VARIABLE = 'MNG_REVIEW_RISK_DESCRIPTION'
/** The step output that carries step 1's description to the cleanup step. */
export const RISK_DESCRIPTION_OUTPUT = 'risk-description'

/** What decides whether publish rates: the app's environment and the repository's default branch. */
export interface RiskRunSettings {
	/** `app-environment`; empty when the caller passed none, and then nothing is rated. */
	readonly environment: string
	/** The repository's default branch; only a pull request into it is rated. */
	readonly defaultBranch: string
}

/** `MNG_REVIEW_APP_ENVIRONMENT` and `MNG_REVIEW_DEFAULT_BRANCH`, empty when unset. */
export const riskRunConfig = Config.all({
	environment: Config.String(APP_ENVIRONMENT_VARIABLE).pipe(
		Config.withDefault('')
	),
	defaultBranch: Config.String(DEFAULT_BRANCH_VARIABLE).pipe(
		Config.withDefault('')
	),
}).pipe(
	Config.map((settings): RiskRunSettings => ({
		environment: settings.environment.trim(),
		defaultBranch: settings.defaultBranch.trim(),
	}))
)

/**
 * `MNG_REVIEW_RISK_DESCRIPTION`: step 1's description from the publish step's output, for the
 * cleanup step; anything but the exact form is no description, so the cleanup only removes labels.
 */
export const riskDescriptionConfig = Config.option(
	Config.String(RISK_DESCRIPTION_VARIABLE)
).pipe(
	Config.map(
		(value): RiskDescription | undefined =>
			parseRiskDescription(Option.getOrElse(value, () => '').trim()) ??
			undefined
	)
)

/**
 * `MNG_REVIEW_HELD_REPLY`: the reply a dispatched converse was sent for; a resolved thread that
 * holds it is answered as if open. Unset or not a whole number above 0 is no reply.
 */
export const heldReplyConfig = Config.option(
	Config.Int('MNG_REVIEW_HELD_REPLY')
).pipe(
	Config.map(value => {
		const held = Option.getOrUndefined(value)
		return held !== undefined && held > 0 ? held : undefined
	})
)

/** `GITHUB_RUN_ID` as a number, the run every answer's marker names; unset outside a workflow. */
export const runIdConfig = Config.option(Config.Int('GITHUB_RUN_ID')).pipe(
	Config.map(Option.getOrUndefined)
)

/** What the denial job posts, from the decide job's outputs. */
export const refusalConfig = Config.all({
	pullNumber: Config.Int('MNG_REVIEW_TARGET_PR'),
	commentId: Config.Int('MNG_REVIEW_ANSWER_COMMENT'),
	kind: Config.Literals(REFUSAL_KINDS, 'MNG_REVIEW_ANSWER_KIND'),
	reason: Config.String('MNG_REVIEW_ANSWER_REASON').pipe(
		Config.withDefault('the command was refused')
	),
	run: Config.Int('GITHUB_RUN_ID'),
})

/** The review workflow `status-sweep.yml` dispatches, such as `review.yml`; empty dispatches nothing. */
export const dispatchWorkflowConfig = Config.String(
	'MNG_REVIEW_DISPATCH_WORKFLOW'
).pipe(Config.withDefault(''))

/** The pull request one risk sweep job checks, and the id every run it counts must carry. */
export interface RiskSweepTarget {
	readonly pullNumber: number
	readonly repositoryId: number
}

/** `MNG_REVIEW_TARGET_PR` from the matrix and the runner's `GITHUB_REPOSITORY_ID`. */
export const riskSweepTargetConfig = Config.all({
	pullNumber: Config.Int('MNG_REVIEW_TARGET_PR'),
	repositoryId: Config.Int('GITHUB_REPOSITORY_ID'),
}).pipe(Config.map((target): RiskSweepTarget => target))
