import type {
	Change,
	ChangedFile,
	DeclaredAgent,
	ModelSetting,
	RouterReport,
} from '@mng-review/domain'
import { Context, Effect, Layer } from 'effect'
import { LanguageModel, Toolkit } from 'effect/ai'
import { GitService } from '../../../platform/git/git.service'
import { LlmService } from '../../../platform/llm/llm.service'
import { toRouterUserMessage } from '../domain/router-prompt.helper'
import { parseRouterAnswer } from '../infrastructure/router-answer.parser'
import { RouteTool } from './route.tool'
import { ROUTER_PROMPT } from './router.prompt'

const ROUTE_TOOLKIT = Toolkit.make(RouteTool)
const UNEXPECTED_FAILURE = 'router failed unexpectedly'

/** What the router is asked about. */
export interface RouterRequest {
	/** The diff runs between its merge base and head. */
	readonly change: Pick<Change, 'mergeBase' | 'head'>
	/** Reviewable files only. */
	readonly files: readonly ChangedFile[]
	/** Agents that failed only on `when.paths` and have a triage line. */
	readonly candidates: readonly DeclaredAgent[]
	readonly model: ModelSetting
}

/**
 * Asks the router model for agents to add and a risk level. It never fails: a diff that cannot be
 * read, an endpoint error or an unusable answer comes back as a `failed` report, and the plan goes
 * on with path selection and risk `normal`.
 */
export class RouterService extends Context.Service<
	RouterService,
	{ readonly route: (request: RouterRequest) => Effect.Effect<RouterReport> }
>()('mng-review/RouterService') {}

/** The report of a router that did not answer. */
function toFailedReport(detail: string): RouterReport {
	return { status: 'failed', detail, added: [] }
}

/** A router that reports `failed` with the reason it cannot run, such as a missing endpoint. */
export function makeUnavailableRouterLayer(
	reason: string
): Layer.Layer<RouterService> {
	return Layer.succeed(RouterService, {
		route: () => Effect.succeed(toFailedReport(reason)),
	})
}

export const RouterServiceLive = Layer.effect(
	RouterService,
	Effect.gen(function* () {
		const git = yield* GitService
		const llm = yield* LlmService

		const ask = Effect.fn('RouterService.ask')(function* (
			request: RouterRequest
		) {
			const diff = yield* git.readDiff(request.change, request.files)
			const response = yield* llm.run(
				request.model,
				LanguageModel.generateText({
					prompt: [
						{ role: 'system', content: ROUTER_PROMPT },
						{
							role: 'user',
							content: toRouterUserMessage(
								request.files,
								request.candidates,
								diff
							),
						},
					],
					toolkit: ROUTE_TOOLKIT,
					toolChoice: { tool: RouteTool.name },
					disableToolCallResolution: true,
					toolCallValidation: 'deferred',
				})
			)
			const routeCall = response.toolCalls.find(
				call => call.name === RouteTool.name
			)
			return yield* parseRouterAnswer(
				routeCall?.params,
				response.text,
				request.candidates
			)
		})

		const route = Effect.fn('RouterService.route')(function* (
			request: RouterRequest
		) {
			return yield* ask(request).pipe(
				Effect.catch(error => Effect.succeed(toFailedReport(error.message))),
				Effect.catchDefect(() =>
					Effect.succeed(toFailedReport(UNEXPECTED_FAILURE))
				)
			)
		})

		return { route }
	})
)
