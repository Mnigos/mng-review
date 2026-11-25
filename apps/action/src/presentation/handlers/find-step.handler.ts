import { RulesService } from '@mng-review/engine'
import {
	GitHubConfig,
	type LiftFindResult,
	provideListCompleteness,
	provideOwnedIdentities,
	type ReplyCandidate,
	type ReplyFindResult,
	ReplyFindService,
	RequestLiftService,
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
/** The most jobs GitHub builds from one matrix; the rest of the lifts wait for the next tick. */
export const LIFT_MATRIX_LIMIT = 256

/** A pull request the lift job judges again, as its matrix takes it. */
export interface LiftEntry {
	readonly number: number
}

/** What the find step lists for the later jobs. */
interface FindLists {
	readonly pulls: readonly ReplyCandidate[]
	readonly lifts: readonly LiftEntry[]
}

/** The lifts `findDue` listed, or why it could not list them. */
interface ListedLifts extends LiftFindResult {
	readonly error?: string
}

/** Nothing for any later job. */
const NOTHING_FOUND = { pulls: [], lifts: [] } as const satisfies FindLists

/** What the find step found, in words, with the pull requests whose read failed. */
function toFindLine(found: ReplyFindResult, due: ListedLifts): string {
	const { candidates, failed } = found
	const skipped =
		failed > 0 ? `; ${failed} pull request(s) could not be read` : ''
	const lifts =
		due.pulls.length === 0
			? ''
			: `; a change request to lift on ${due.pulls.map(pull => `#${pull}`).join(', ')}`
	const unjudged =
		due.failed > 0
			? `; ${due.failed} pull request(s) could not be judged for a lift`
			: ''
	const unlisted =
		due.error === undefined
			? ''
			: `; the change requests to lift could not be listed: ${due.error}`
	const tail = `${skipped}${lifts}${unjudged}${unlisted}`
	if (candidates.length === 0)
		return `reply schedule: no reply waits for an answer${tail}`
	return `reply schedule: replies wait on ${candidates.map(pull => `#${pull.number}`).join(', ')}${tail}`
}

/** Writes `pulls` and `lifts`, the log line and the job summary. */
const finishFind = Effect.fn('findStep.finish')(function* (
	lists: FindLists,
	line: string
) {
	const env = yield* runnerEnvironmentConfig
	yield* writeOutputs(yield* outputPathConfig, {
		pulls: JSON.stringify(lists.pulls),
		lifts: JSON.stringify(lists.lifts),
	})
	yield* Console.log(toLogText(`mng-review: ${line}`))
	yield* writeSummary(env.summaryPath, formatFindSummary(line))
})

/** Lists nothing and ends the step with exit 1, so a broken schedule shows red. */
const failFind = Effect.fn('findStep.fail')(function* (line: string) {
	yield* finishFind(NOTHING_FOUND, `reply schedule failed: ${line}`)
	return yield* new ActionExit({ code: FAILED_EXIT_CODE })
})

/**
 * The find step of the reply schedule: lists the open pull requests of this repository with a
 * reply waiting in the bot's threads, and those whose current-identity change request nothing backs
 * any more (`RequestLiftService.findDue`), over the read token, with the owned identities and
 * `commands.allow` from the default branch's rules, so a pull request never decides whose threads
 * count. It calls no model and writes nothing on GitHub. The step output `pulls` is a JSON list of
 * numbers and full commit SHAs, which the review and publish jobs take as their matrix; `lifts` is
 * a JSON list of numbers, at most `LIFT_MATRIX_LIMIT`, for the lift job, which judges each again
 * inside its pull request's publish group. A pull request may be in both: its replies go through
 * the reply path once, and the lift job judges it after its publish leg. A failed list of the open
 * pull requests for the replies, a git error, or a reply read that failed on every pull request
 * lists nothing and exits 1; a read that failed on some is named in the line and the rest are
 * listed. A lift listing that fails lists no lift, is named in the line and keeps the replies. A
 * `ConfigError` is left to `failFindConfig`.
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
	// A lift listing that fails lists no lift but keeps the replies: the reply legs need find to pass.
	const due = yield* RequestLiftService.use(service =>
		service.findDue(rules.config.commands.allow)
	).pipe(
		provideOwnedIdentities(identity, rules.config.identity.previous),
		provideListCompleteness(rules.config.risk.enabled),
		Effect.map((listed): ListedLifts => listed),
		Effect.catchTag('GitHubApiError', error =>
			Effect.succeed<ListedLifts>({
				pulls: [],
				read: 0,
				failed: 0,
				error: error.message,
			})
		)
	)
	return yield* finishFind(
		{
			pulls: found.candidates,
			lifts: due.pulls
				.slice(0, LIFT_MATRIX_LIMIT)
				.map((number): LiftEntry => ({ number })),
		},
		toFindLine(found, due)
	)
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
	yield* finishFind(NOTHING_FOUND, `reply schedule failed: ${error.message}`)
	return yield* new ActionExit({ code: INVALID_CONFIG_EXIT_CODE })
})
