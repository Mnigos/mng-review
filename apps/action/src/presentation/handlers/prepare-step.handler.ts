import type { Rules } from '@mng-review/engine'
import {
	type BotThread,
	GitHubConfig,
	provideOwnedIdentities,
	PublishService,
	ReplyFindService,
	SummaryCommentService,
	ThreadReplyService,
	toLogText,
} from '@mng-review/github'
import { Console, Effect, FileSystem } from 'effect'
import type { CommandEventRead } from '../../application/command-run.types'
import { PrepareRunService } from '../../application/prepare-run.service'
import type {
	PreparedRun,
	PriorRun,
	PullRequestEvent,
} from '../../application/shadow-run.types'
import {
	commandTargetConfig,
	runNumberConfig,
	triggerConfig,
} from '../../infrastructure/command-run.config'
import {
	outputPathConfig,
	writeOutputs,
} from '../../infrastructure/runner-output.client'
import {
	readEventText,
	runnerEnvironmentConfig,
	writePrepared,
} from '../../infrastructure/runner.client'
import { readCommandEvent } from './command-event.handler'

/** The prepare step's log line: the prepared status and, unless it is ready, why. */
function toPrepareLine(prepared: PreparedRun): string {
	const reason = prepared.status === 'ready' ? '' : `: ${prepared.reason}`
	return toLogText(`mng-review: prepare ${prepared.status}${reason}`)
}

/**
 * A command or reply schedule run's pull request, read again instead of the event; a closed, moved
 * or fork pull request skips the run. `undefined` for a push run.
 */
const readCommandRun = Effect.gen(function* () {
	const trigger = yield* triggerConfig
	if (trigger === 'push') return undefined
	return yield* readCommandEvent(yield* commandTargetConfig, trigger)
}).pipe(
	Effect.catchTag('ConfigError', error =>
		Effect.succeed({
			status: 'skipped',
			reason: `the command's target cannot be read: ${error.message}`,
		} satisfies CommandEventRead)
	)
)

/**
 * The prepare step of the review job: the checks before the probe and the GitHub reads over the
 * read token, with no endpoint variable and no model. The comments of every bot identity the base
 * rules own count. A GitHub error counts as no prior run and no threads. The authors' replies in
 * those threads are collected before any model call; a GitHub error there counts as no reply. It writes the prepared file and the step output `ready`, and never fails on an
 * outcome; the review step reports it. A reply schedule run reads its threads and replies as the
 * find step does (`ReplyFindService.readPending`).
 */
export const runPrepareStep = Effect.gen(function* () {
	const env = yield* runnerEnvironmentConfig
	const fs = yield* FileSystem.FileSystem
	const publisher = yield* PublishService
	const summaries = yield* SummaryCommentService
	const conversation = yield* ThreadReplyService
	const finder = yield* ReplyFindService
	const { identity } = yield* GitHubConfig
	const trigger = yield* triggerConfig.pipe(
		Effect.orElseSucceed(() => 'push' as const)
	)
	const converse = trigger === 'converse'
	// A reply-only run never advances the run count, so the schedule's run number shifts the batch.
	const rotation = converse
		? yield* runNumberConfig.pipe(Effect.orElseSucceed(() => 0))
		: undefined
	const readPrior = (event: PullRequestEvent, rules: Rules) =>
		summaries.readPrior(event.number).pipe(
			provideOwnedIdentities(identity, rules.config.identity.previous),
			Effect.map((marker): PriorRun | undefined =>
				marker
					? {
							runs: marker.runs,
							...(marker.head === undefined ? {} : { head: marker.head }),
							...(marker.needsOwner ? { waiting: marker.needsOwner } : {}),
						}
					: undefined
			),
			Effect.orElseSucceed(() => undefined)
		)
	const readThreads = (event: PullRequestEvent, rules: Rules) =>
		publisher.readThreads(event.number).pipe(
			provideOwnedIdentities(identity, rules.config.identity.previous),
			Effect.orElseSucceed(() => [])
		)
	const readReplies = (
		event: PullRequestEvent,
		rules: Rules,
		threads: readonly BotThread[],
		prior: PriorRun | undefined
	) =>
		conversation
			.collect({
				pullNumber: event.number,
				threads,
				rotation: rotation ?? prior?.runs ?? 0,
				waiting: prior?.waiting ?? [],
			})
			.pipe(provideOwnedIdentities(identity, rules.config.identity.previous))
	// The schedule's own read: the waiting list from every summary and the bot's answers.
	const readPending = (event: PullRequestEvent, rules: Rules) =>
		finder
			.readPending({ pullNumber: event.number, rotation: rotation ?? 0 })
			.pipe(
				provideOwnedIdentities(identity, rules.config.identity.previous),
				Effect.orElseSucceed(() => ({ threads: [], replies: [] }))
			)
	const command = yield* readCommandRun
	const prepared: PreparedRun =
		command?.status === 'skipped'
			? command
			: yield* PrepareRunService.use(service =>
					service.prepare({
						eventName: env.eventName,
						readEvent: readEventText(env.eventPath).pipe(
							Effect.provideService(FileSystem.FileSystem, fs)
						),
						readPrior,
						...(converse
							? { converse, readPending }
							: { readThreads, readReplies }),
						...(command ? { event: command.event } : {}),
					})
				)
	yield* writePrepared(env.preparedPath, prepared)
	yield* Console.log(toPrepareLine(prepared))
	yield* writeOutputs(yield* outputPathConfig, {
		ready: String(prepared.status === 'ready'),
	})
})
