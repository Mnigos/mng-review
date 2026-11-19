import type { Finding, PullRequestInfo, Validation } from '@mng-review/domain'
import { Context, Effect, Layer } from 'effect'
import type { HttpClient } from 'effect/http'
import type { Rules } from '../../../platform/config/rules.service'
import { GitService } from '../../../platform/git/git.service'
import {
	type TokensByModel,
	TokenLedger,
} from '../../../platform/llm/token-ledger.service'
import {
	MAX_AGENT_WALL_TIME,
	MAX_TOOL_CALLS,
} from '../../review/domain/review.constants'
import { makeValidatorLayer } from '../infrastructure/validation.layers'
import { ValidatorService } from './validator.service'

/** A finding reported at an earlier commit, to check again at the head. */
export interface RecheckItem {
	readonly finding: Finding
	/** The commit the finding was reported on; the validator sees the change from there to the head. */
	readonly base: string
}

/** Findings to check again at one head. */
export interface RecheckRequest {
	readonly rules: Rules
	readonly headRef: string
	readonly pr: PullRequestInfo
	readonly items: readonly RecheckItem[]
}

/** Each finding with the validator's answer at the head, in the request's order. */
export interface RecheckReport {
	readonly results: readonly (RecheckItem & {
		readonly validation: Validation
	})[]
	/** Tokens the whole job spent so far, this check included. */
	readonly tokens: TokensByModel
}

/**
 * Checks earlier findings again at a newer head: one fresh validator per finding, told to refute
 * it, over the change from the commit it was reported on to the head. A rejection means the
 * finding no longer holds there. A finding whose base git cannot read is not checked, and nothing
 * is checked when the endpoint is not configured. Runs inside `limits.tokens_per_run`, shared with
 * the review of the same job.
 */
export class RecheckService extends Context.Service<
	RecheckService,
	{
		readonly recheck: (request: RecheckRequest) => Effect.Effect<RecheckReport>
	}
>()('mng-review/RecheckService') {}

export const RecheckServiceLive = Layer.effect(
	RecheckService,
	Effect.gen(function* () {
		const git = yield* GitService
		const ledger = yield* TokenLedger
		const services = yield* Effect.context<
			GitService | TokenLedger | HttpClient.HttpClient
		>()

		const recheck = Effect.fn('RecheckService.recheck')(function* (
			request: RecheckRequest
		) {
			const { config } = request.rules
			const empty: RecheckReport = {
				results: [],
				tokens: yield* ledger.snapshot,
			}
			if (request.items.length === 0) return empty
			const validator = yield* ValidatorService.pipe(
				Effect.provide(
					makeValidatorLayer({
						concurrency: config.limits.concurrency,
						tokensPerRun: config.limits.tokens_per_run,
						maxFileKb: config.limits.max_file_kb,
						maxToolCalls: MAX_TOOL_CALLS,
						maxWallTime: MAX_AGENT_WALL_TIME,
					})
				),
				Effect.provideContext(services),
				Effect.option
			)
			if (validator._tag === 'None') return empty
			const results = yield* Effect.forEach(
				request.items,
				item =>
					git.readChange(item.base, request.headRef).pipe(
						Effect.flatMap(change =>
							validator.value.validate(item.finding, {
								scope: { change, pr: request.pr },
								config,
								rules: request.rules,
							})
						),
						Effect.map(validation => [{ ...item, validation }]),
						Effect.orElseSucceed(() => [])
					),
				{ concurrency: config.limits.concurrency }
			)
			return { results: results.flat(), tokens: yield* ledger.snapshot }
		})

		return { recheck }
	})
)
