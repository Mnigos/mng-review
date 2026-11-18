import { Effect, Layer, Stream } from 'effect'
import { AiError } from 'effect/ai'
import { ReviewLimits } from '../../modules/review/application/review-limits.context'
import { AgentLoopServiceLive } from '../../modules/review/application/services/agent-loop.service'
import { ModelHealthServiceLive } from '../../modules/review/application/services/model-health.service'
import { RepoToolsServiceLive } from '../../modules/review/application/services/repo-tools.service'
import { GitService } from '../../platform/git/git.service'
import {
	makeScriptedLlmLayer,
	type ScriptedLlmAnswer,
	type ScriptedLlmCall,
} from '../../platform/llm/scripted-llm.layer'
import { TokenLedgerLive } from '../../platform/llm/token-ledger.service'
import { splitCappedLines } from '../../utils/capped-lines.util'
import { DIFF, LIMITS, SCOPE } from './review-test.helper'

/**
 * Deterministic committed repository port; tests needing git semantics use gitLayer instead.
 * `foldLines` folds what `exec` prints.
 */
export function gitFixture(
	overrides: Partial<GitService['Service']> = {}
): GitService['Service'] {
	const exec: GitService['Service']['exec'] =
		overrides.exec ??
		(args =>
			Effect.succeed({
				exitCode: 0,
				stdout:
					args[0] === 'ls-tree'
						? `100644 blob ${'a'.repeat(40)} 30\tsrc/billing/charge.ts\0`
						: args[0] === 'show'
							? 'const balance = 9\ncharge(balance)'
							: '',
				stderr: '',
			}))
	return {
		root: '/fixture',
		exec,
		foldLines: (args, fold) =>
			exec(args).pipe(
				Effect.flatMap(({ stdout, ...result }) =>
					Stream.runFold(
						splitCappedLines(Stream.make(stdout), fold.maxLineChars),
						() => fold.initial,
						fold.step
					).pipe(Effect.map(state => ({ ...result, state })))
				)
			),
		readDiff: () => Effect.succeed(DIFF),
		readFileAt: () => Effect.succeed('const balance = 9\ncharge(balance)'),
		resolveCommit: () => Effect.succeed('head'),
		mergeBase: () => Effect.succeed('base'),
		branchName: () => Effect.succeed('main'),
		readChange: () => Effect.succeed(SCOPE.change),
		listFilesAt: () => Effect.succeed([]),
		getFilesAt: (_commit, paths) => Effect.succeed(new Set(paths)),
		...overrides,
	}
}

/** Shared model gate, real agent loop and real repository tools, over replaceable local ports. */
export function reviewDependencies(
	script: ScriptedLlmAnswer,
	limits: Partial<ReviewLimits['Service']> = {},
	git = gitFixture()
) {
	return AgentLoopServiceLive.pipe(
		Layer.provideMerge(
			Layer.mergeAll(ModelHealthServiceLive, RepoToolsServiceLive)
		),
		Layer.provideMerge(makeScriptedLlmLayer(script)),
		Layer.provideMerge(TokenLedgerLive),
		Layer.provide(Layer.succeed(ReviewLimits, { ...LIMITS, ...limits })),
		Layer.provideMerge(Layer.succeed(GitService, git))
	)
}

/** Provider failures with the same HTTP status metadata the endpoint adapter returns. */
export function providerError(status: number, description = 'fixture failure') {
	const http = { response: { status, headers: {} } } as const
	const reason =
		status === 429
			? new AiError.RateLimitError({ http })
			: status >= 500
				? new AiError.InternalProviderError({ description, http })
				: new AiError.InvalidRequestError({ description, http })
	return new AiError.AiError({
		module: 'fixture',
		method: 'generateText',
		reason,
	})
}

/** Identifies a conversation by its offered finish tool, independent of scheduling order. */
export function offers(call: ScriptedLlmCall, name: string) {
	return call.options.tools.some(tool => tool.name === name)
}

/** First user message text, as encoded by effect/ai for the provider. */
export function userText(call: ScriptedLlmCall | undefined) {
	const message = call?.options.prompt.content.find(
		entry => entry.role === 'user'
	)
	return message?.role === 'user'
		? message.content
				.filter(part => part.type === 'text')
				.map(part => part.text)
				.join('\n')
		: ''
}
