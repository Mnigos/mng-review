import { RulesService } from '@mng-review/engine'
import {
	GitHubConfig,
	provideListCompleteness,
	provideOwnedIdentities,
	type ReplyCandidate,
	type ReplyFindResult,
	ReplyFindService,
	toLogText,
} from '@mng-review/github'
import { Console, Effect } from 'effect'
import {
	maxPullRequestsConfig,
	runNumberConfig,
} from '../../infrastructure/command-run.config'
import {
	outputPathConfig,
	writeOutputs,
} from '../../infrastructure/runner-output.client'
import {
	runnerEnvironmentConfig,
	writeSummary,
} from '../../infrastructure/runner.client'
import {
	ActionExit,
	FAILED_EXIT_CODE,
	INVALID_CONFIG_EXIT_CODE,
} from '../action-exit.errors'
import { formatFindSummary } from '../summary.formatter'

/** The rules the find step reads the owned identities from: `HEAD` of the default branch checkout. */
const FIND_RULES_REF = 'HEAD'

/** What the find step found, in words, with the pull requests whose read failed. */
function toFindLine(found: ReplyFindResult): string {
	const { candidates, failed } = found
	const skipped =
		failed > 0 ? `; ${failed} pull request(s) could not be read` : ''
	if (candidates.length === 0)
		return `reply schedule: no reply waits for an answer${skipped}`
	return `reply schedule: replies wait on ${candidates.map(pull => `#${pull.number}`).join(', ')}${skipped}`
}

/** Writes `pulls`, the log line and the job summary. */
const finishFind = Effect.fn('findStep.finish')(function* (
	pulls: readonly ReplyCandidate[],
	line: string
) {
	const env = yield* runnerEnvironmentConfig
	yield* writeOutputs(yield* outputPathConfig, {
		pulls: JSON.stringify(pulls),
	})
	yield* Console.log(toLogText(`mng-review: ${line}`))
	yield* writeSummary(env.summaryPath, formatFindSummary(line))
})

/** Lists nothing and ends the step with exit 1, so a broken schedule shows red. */
const failFind = Effect.fn('findStep.fail')(function* (line: string) {
	yield* finishFind([], `reply schedule failed: ${line}`)
	return yield* new ActionExit({ code: FAILED_EXIT_CODE })
})

/**
 * The find step of the reply schedule: lists the open pull requests of this repository with a
 * reply waiting in the bot's threads, over the read token, with the owned identities from the
 * default branch's rules, so a pull request never decides whose threads count. It calls no model
 * and writes nothing on GitHub. The step output `pulls` is a JSON list of numbers and full commit
 * SHAs, which the later jobs take as their matrix. A failed list of the open pull requests, a git
 * error, or a read that failed on every pull request lists nothing and exits 1; a read that failed
 * on some is named in the line and the rest are listed. A `ConfigError` is left to
 * `failFindConfig`.
 */
export const runFindStep = Effect.gen(function* () {
	const rules = yield* RulesService.use(service => service.load(FIND_RULES_REF))
	const { identity } = yield* GitHubConfig
	const max = yield* maxPullRequestsConfig
	const rotation = yield* runNumberConfig
	const found = yield* ReplyFindService.use(service =>
		service.find({ max, rotation })
	).pipe(
		provideOwnedIdentities(identity, rules.config.identity.previous),
		provideListCompleteness(rules.config.risk.enabled),
		Effect.catchTag('GitHubApiError', error => failFind(error.message))
	)
	if (found.read > 0 && found.failed === found.read)
		return yield* failFind(
			`no open pull request could be read (${found.failed})`
		)
	return yield* finishFind(found.candidates, toFindLine(found))
}).pipe(Effect.catchTag('GitError', error => failFind(`git: ${error.message}`)))

/** A domain `ConfigError` (the token, the rules, a setting) or one of Effect's own config errors. */
interface ConfigFailure {
	readonly message: string
}

/**
 * A broken token, setting or rules on the default branch: nothing is listed, and the step ends with
 * exit 2.
 */
export const failFindConfig = Effect.fn('findStep.failConfig')(function* (
	error: ConfigFailure
) {
	yield* finishFind([], `reply schedule failed: ${error.message}`)
	return yield* new ActionExit({ code: INVALID_CONFIG_EXIT_CODE })
})
