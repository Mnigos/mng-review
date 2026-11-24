import { parseRiskDescription, type RiskDescription } from '@mng-review/domain'
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
