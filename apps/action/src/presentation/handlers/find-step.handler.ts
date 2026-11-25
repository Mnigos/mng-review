import { RulesService } from '@mng-review/engine'
import {
	GitHubConfig,
	type RaiseFindResult,
	provideListCompleteness,
	provideOwnedIdentities,
	type ReplyCandidate,
	type ReplyFindResult,
	ReplyFindService,
	RaiseService,
	toLogText,
} from '@mng-review/github'
import { Clock, Console, Duration, Effect } from 'effect'
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
/** The most jobs GitHub builds from one matrix; the rest of the raises wait for a later run. */
export const RAISE_MATRIX_LIMIT = 256
/**
 * How long after the step starts the raise scan may start judgments after its first. It runs beside
 * the reply scan, and a judgment that started runs to its end unless the scan reaches
 * `RAISE_SCAN_BOUND`.
 */
export const RAISE_SCAN_DEADLINE = Duration.minutes(2)
/**
 * When, after the step starts, the whole raise scan ends, whatever still runs: the judgments
 * finished by then are listed, and one still running is dropped for the tick. The job's setup takes
 * up to about a minute before the step, so this lands near four of the find job's five minutes and
 * leaves room to write the outputs; the replies are never lost to a hung judgment.
 */
export const RAISE_SCAN_BOUND = Duration.minutes(3)
/**
 * The most full raise judgments one tick makes (about six to ten requests each on `github.token`,
 * whose 1,000 requests an hour every workflow of the repository shares); the first reads, a status
 * and the reviews of each open pull request, add about 2N for N open ones and are not capped. The
 * scan starts `getScanStride` pull requests further each run number, so every one is judged within
 * N ticks, and within ceil(N / step) when ticks make their judgments, both while N stays the same.
 */
export const RAISE_SCAN_LIMIT = 20

/** A pull request the raise job judges again, as its matrix takes it. */
export interface RaiseEntry {
	readonly number: number
}

/** What the find step lists for the later jobs. */
interface FindLists {
	readonly pulls: readonly ReplyCandidate[]
	readonly raises: readonly RaiseEntry[]
}

/** The raises `findDue` listed, or why it could not list them. */
interface ListedRaises extends RaiseFindResult {
	readonly error?: string
}

/** Why no raise was listed, as the line and the run page's warning say it. */
function toUnlistedText(error: string): string {
	return `the pull requests to raise could not be listed: ${error}`
}

/** The bound ended the raise scan before its listing returned, so nothing was judged. */
const UNLISTED_AT_BOUND =
	'the raise scan hit its hard bound before it listed the open pull requests'

/** Whether the bound ended the raise scan before its listing returned. */
function isCutBeforeListing(due: ListedRaises): boolean {
	return due.stop === 'bound' && due.read === 0
}

/** The run page's warning for a raise scan cut short, worded from where it stopped. */
function toCutWarning(due: ListedRaises): string | undefined {
	const left = `${due.unscanned} pull request(s) not judged this tick`
	if (due.dropped !== undefined)
		return `the raise scan hit its hard bound while judging #${due.dropped}; ${left}`
	if (isCutBeforeListing(due)) return `${UNLISTED_AT_BOUND}; no raise this tick`
	if (due.stop === 'bound')
		return `the raise scan hit its hard bound between judgments; ${left}`
	if (due.unscanned > 0) return `the raise scan reached its deadline; ${left}`
	return undefined
}

/** No raise listed, named in the line and warned on the run page, since find still passes. */
const listNoRaise = Effect.fn('findStep.listNoRaise')(function* (
	error: string
) {
	yield* Console.log(`::warning::${toLogText(toUnlistedText(error))}`)
	const none: ListedRaises = {
		pulls: [],
		read: 0,
		failed: 0,
		unscanned: 0,
		deferred: 0,
		error,
	}
	return none
})

/** Nothing for any later job. */
const NOTHING_FOUND = { pulls: [], raises: [] } as const satisfies FindLists

/** What the find step found, in words, with the pull requests whose read failed. */
function toFindLine(found: ReplyFindResult, due: ListedRaises): string {
	const { candidates, failed } = found
	const skipped =
		failed > 0 ? `; ${failed} pull request(s) could not be read` : ''
	const raises =
		due.pulls.length === 0
			? ''
			: `; a status or change request to raise on ${due.pulls.map(pull => `#${pull}`).join(', ')}`
	const unjudged =
		due.failed > 0
			? `; ${due.failed} pull request(s) could not be judged for a raise`
			: ''
	const unlisted =
		due.error === undefined
			? isCutBeforeListing(due)
				? `; ${UNLISTED_AT_BOUND}`
				: ''
			: `; ${toUnlistedText(due.error)}`
	const unscanned =
		due.unscanned > 0
			? `; ${due.unscanned} pull request(s) not judged for a raise before the ${due.stop === 'bound' ? 'hard bound' : 'deadline'}`
			: ''
	const deferred =
		due.deferred > 0
			? `; ${due.deferred} pull request(s) left for later ticks after ${RAISE_SCAN_LIMIT} judgments`
			: ''
	const dropped =
		due.dropped === undefined
			? ''
			: `; the raise judgment of #${due.dropped} was cut at the hard bound`
	const tail = `${skipped}${raises}${unjudged}${unscanned}${dropped}${deferred}${unlisted}`
	if (candidates.length === 0)
		return `reply schedule: no reply waits for an answer${tail}`
	return `reply schedule: replies wait on ${candidates.map(pull => `#${pull.number}`).join(', ')}${tail}`
}

/** Writes `pulls` and `raises`, the log line and the job summary. */
const finishFind = Effect.fn('findStep.finish')(function* (
	lists: FindLists,
	line: string
) {
	const env = yield* runnerEnvironmentConfig
	yield* writeOutputs(yield* outputPathConfig, {
		pulls: JSON.stringify(lists.pulls),
		raises: JSON.stringify(lists.raises),
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
 * reply waiting in the bot's threads, and those with a raise due (`RaiseService.findDue`: the plan
 * differs from the bot's status, or its current-identity change request would be lifted), over the
 * read token, with the owned identities and `commands.allow` from the default branch's rules, so a
 * pull request never decides whose threads count. It calls no model and writes nothing on GitHub.
 * The step output `pulls` is a JSON list of numbers and full commit SHAs, which the review and
 * publish jobs take as their matrix; `raises` is a JSON list of numbers, at most
 * `RAISE_MATRIX_LIMIT`, for the raise job, which judges each again inside its pull request's
 * publish group. A pull request may be in both: its replies go through the reply path once, and the
 * raise job judges it after its publish leg. A failed list of the open pull requests for the
 * replies, a git error, or a reply read that failed on every pull request lists nothing and exits
 * 1; a read that failed on some is named in the line and the rest are listed. The raise scan runs
 * beside the reply scan, makes at most `RAISE_SCAN_LIMIT` full judgments, starts up to that many
 * pull requests further each run number, always judges the one at its start and starts no later
 * judgment past `RAISE_SCAN_DEADLINE`; it lists what it judged, in its order, and warns only about
 * what the deadline left out. At `RAISE_SCAN_BOUND` the whole scan, its listing included, ends:
 * what it judged is listed, the judgment in flight is dropped, the warning says where the bound cut,
 * and the outputs are written. Every due pull request is listed within N ticks for N open ones, and
 * within ceil(N / step) for the `getScanStride` step when ticks make their judgments, both while N
 * stays the same. A raise listing that fails lists no raise, warns, is named in the line and keeps
 * the replies. A `ConfigError` is left to `failFindConfig`.
 */
export const runFindStep = Effect.gen(function* () {
	const started = yield* Clock.currentTimeMillis
	const rules = yield* RulesService.use(service => service.load(FIND_RULES_REF))
	const { identity } = yield* GitHubConfig
	const max = yield* maxPullRequestsConfig
	const rotation = yield* runNumberConfig
	const replies = ReplyFindService.use(service =>
		service.find({ max, rotation })
	).pipe(
		provideOwnedIdentities(identity, rules.config.identity.previous),
		provideListCompleteness(rules.config.risk.enabled),
		Effect.catchTag('GitHubApiError', error => failFind(error.message))
	)
	// The raise scan starts further each run and stops starting judgments at its deadline, keeping
	// what it judged; a listing that fails or outlasts the bound lists no raise but keeps the replies.
	const raises = RaiseService.use(service =>
		service.findDue(rules.config.commands.allow, {
			rotation,
			deadline: started + Duration.toMillis(RAISE_SCAN_DEADLINE),
			bound: started + Duration.toMillis(RAISE_SCAN_BOUND),
			limit: RAISE_SCAN_LIMIT,
		})
	).pipe(
		provideOwnedIdentities(identity, rules.config.identity.previous),
		provideListCompleteness(rules.config.risk.enabled),
		Effect.map((listed): ListedRaises => listed),
		Effect.catchTag('GitHubApiError', error => listNoRaise(error.message))
	)
	// Side by side, so a slow reply scan never takes the raise scan's time.
	const [found, due] = yield* Effect.all([replies, raises], {
		concurrency: 2,
	})
	if (found.read > 0 && found.failed === found.read)
		return yield* failFind(
			`no open pull request could be read (${found.failed})`
		)
	const cut = toCutWarning(due)
	if (cut !== undefined) yield* Console.log(`::warning::${toLogText(cut)}`)
	return yield* finishFind(
		{
			pulls: found.candidates,
			// In the scan's order, which already starts further each run number; a second rotation here
			// would cancel it.
			raises: due.pulls
				.slice(0, RAISE_MATRIX_LIMIT)
				.map((number): RaiseEntry => ({ number })),
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
