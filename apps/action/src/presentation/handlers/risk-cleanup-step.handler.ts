import { DEFAULT_RISK_LABELS } from '@mng-review/domain'
import { RulesService } from '@mng-review/engine'
import {
	GitHubConfig,
	provideOwnedIdentities,
	RiskFinishService,
	toLogText,
} from '@mng-review/github'
import { Console, Effect } from 'effect'
import { commandTargetConfig } from '../../infrastructure/command-run.config'
import { riskDescriptionConfig } from '../../infrastructure/risk-run.config'
import { ActionExit, INVALID_CONFIG_EXIT_CODE } from '../action-exit.errors'

/**
 * The cleanup step after a failed or cancelled publish: writes step 1's `error` again from the
 * description the publish step put out, never a lower level, and removes the bot's risk label. A
 * run that stopped before step 1 has no description, so only the label goes. Rules that do not
 * load fall back to the default label names; the status is what matters.
 */
export const runRiskCleanupStep = Effect.gen(function* () {
	const target = yield* commandTargetConfig
	const description = yield* riskDescriptionConfig
	const rules = yield* RulesService.use(service =>
		service.load(target.base)
	).pipe(Effect.option)
	const { identity } = yield* GitHubConfig
	const config = rules._tag === 'Some' ? rules.value.config : undefined
	const result = yield* RiskFinishService.use(service =>
		service.revokeHead({
			pullNumber: target.pullNumber,
			head: target.head,
			labels: config?.risk.labels ?? DEFAULT_RISK_LABELS,
			...(description?.pr === target.pullNumber ? { description } : {}),
		})
	).pipe(provideOwnedIdentities(identity, config?.identity.previous ?? []))
	const label = result.labelFailed ? '; a label removal failed' : ''
	yield* Console.log(
		toLogText(
			`mng-review: risk cleanup ${result.state === 'error' ? `wrote error at ${result.level}` : 'wrote no status'}${label}`
		)
	)
})

/** A domain `ConfigError` or one of Effect's own config errors. */
interface ConfigFailure {
	readonly message: string
}

/** A missing target or token setting: reported, and the step ends with exit 2. */
export const failRiskCleanupConfig = Effect.fn('riskCleanupStep.failConfig')(
	function* (error: ConfigFailure) {
		yield* Console.log(
			toLogText(`mng-review: risk cleanup failed: ${error.message}`)
		)
		return yield* new ActionExit({ code: INVALID_CONFIG_EXIT_CODE })
	}
)
