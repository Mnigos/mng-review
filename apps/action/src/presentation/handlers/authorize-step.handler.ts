import { RulesService } from '@mng-review/engine'
import {
	CommandAnswerService,
	CommandAuthorizeService,
	type CommandDecision,
	GitHubConfig,
	provideOwnedIdentities,
} from '@mng-review/github'
import { Console, Effect } from 'effect'
import { commandHandlesConfig } from '../../infrastructure/command-run.config'
import { parseIssueCommentEvent } from '../../infrastructure/issue-comment-event.parser'
import {
	outputPathConfig,
	writeOutputs,
} from '../../infrastructure/runner-output.client'
import {
	readEventText,
	runnerEnvironmentConfig,
	writeSummary,
} from '../../infrastructure/runner.client'
import {
	formatAuthorizeLogLine,
	formatAuthorizeSummary,
	toAuthorizeOutputs,
} from '../command.formatter'

/** The rules the authorize step reads: `HEAD` of the default branch, where `issue_comment` runs. */
const AUTHORIZE_RULES_REF = 'HEAD'

/** Writes the outputs, the log line and the job summary of a decision. */
const finishAuthorize = Effect.fn('authorizeStep.finish')(function* (
	decision: CommandDecision
) {
	const env = yield* runnerEnvironmentConfig
	yield* writeOutputs(yield* outputPathConfig, toAuthorizeOutputs(decision))
	yield* Console.log(formatAuthorizeLogLine(decision))
	yield* writeSummary(env.summaryPath, formatAuthorizeSummary(decision))
})

/** The comment, the handle inputs and the default branch's rules, checked by the service. */
const decide = Effect.gen(function* () {
	const env = yield* runnerEnvironmentConfig
	const comment = yield* parseIssueCommentEvent(
		yield* readEventText(env.eventPath),
		env.eventName
	)
	const handles = yield* commandHandlesConfig
	const rules = yield* RulesService.use(service =>
		service.load(AUTHORIZE_RULES_REF)
	)
	const { identity } = yield* GitHubConfig
	const owned = provideOwnedIdentities(identity, rules.config.identity.previous)
	const decision = yield* CommandAuthorizeService.use(service =>
		service.authorize({ comment, handles, rules })
	).pipe(owned)
	// With a rating: a refused command gets a denial answer, a review past the cap a cap reply.
	return yield* CommandAnswerService.use(service =>
		service.check({ comment, decision, config: rules.config })
	).pipe(owned)
})

/**
 * The authorize job's step: checks a comment without any secret, over the read token, and writes
 * the outputs the later jobs start from. A failure is a denial and the step passes, except a
 * failed role or cap read of the rating's checks, which fails the job with no outputs.
 */
export const runAuthorizeStep = Effect.gen(function* () {
	const decision = yield* decide.pipe(
		Effect.catchTags({
			ConfigError: error =>
				Effect.succeed({
					status: 'denied',
					reason: error.message,
				} satisfies CommandDecision),
			GitError: error =>
				Effect.succeed({
					status: 'denied',
					reason: `git: ${error.message}`,
				} satisfies CommandDecision),
		})
	)
	yield* finishAuthorize(decision)
})

/** A domain `ConfigError` or one of Effect's own config errors. */
interface ConfigFailure {
	readonly message: string
}

/** A token or app setting the read config refuses: a denial, never a failed job. */
export const denyAuthorizeConfig = Effect.fn('authorizeStep.denyConfig')(
	function* (error: ConfigFailure) {
		return yield* finishAuthorize({ status: 'denied', reason: error.message })
	}
)
