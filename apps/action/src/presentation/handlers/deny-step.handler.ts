import { RulesService } from '@mng-review/engine'
import {
	CommandAnswerService,
	GitHubConfig,
	provideOwnedIdentities,
	toLogText,
} from '@mng-review/github'
import { Console, Effect } from 'effect'
import { refusalConfig } from '../../infrastructure/risk-run.config'
import {
	ActionExit,
	FAILED_EXIT_CODE,
	INVALID_CONFIG_EXIT_CODE,
} from '../action-exit.errors'

/** The rules the denial job reads `identity.previous` from: the default branch checkout. */
const DENY_RULES_REF = 'HEAD'

/**
 * The denial job's step, outside the risk group since it writes no status: posts the decide job's
 * denial or cap reply as a new comment whose answer marker names the command at the version it
 * read, so the command stops holding the pull request. A comment that no longer holds the command
 * gets nothing. A failed read or post fails the job (exit 1): the command stays unanswered and
 * nothing dispatches it again, so the failure must show.
 */
export const runDenyStep = Effect.gen(function* () {
	const refusal = yield* refusalConfig
	const rules = yield* RulesService.use(service => service.load(DENY_RULES_REF))
	const { identity } = yield* GitHubConfig
	const posted = yield* CommandAnswerService.use(service =>
		service.post(refusal)
	).pipe(
		provideOwnedIdentities(identity, rules.config.identity.previous),
		Effect.catchTag('GitHubApiError', error =>
			Console.log(
				toLogText(`mng-review: ${refusal.kind} reply failed: ${error.message}`)
			).pipe(Effect.andThen(new ActionExit({ code: FAILED_EXIT_CODE })))
		)
	)
	yield* Console.log(
		toLogText(
			`mng-review: ${posted ? `posted the ${refusal.kind} reply` : `no ${refusal.kind} reply posted`} for comment ${refusal.commentId}`
		)
	)
})

/** A domain `ConfigError` or one of Effect's own config errors. */
interface ConfigFailure {
	readonly message: string
}

/** A missing input or token setting: reported, and the step ends with exit 2. */
export const failDenyConfig = Effect.fn('denyStep.failConfig')(function* (
	error: ConfigFailure
) {
	yield* Console.log(toLogText(`mng-review: denial failed: ${error.message}`))
	return yield* new ActionExit({ code: INVALID_CONFIG_EXIT_CODE })
})
