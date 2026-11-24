import {
	type Change,
	getReviewableFiles,
	normalizeRepoPath,
	parseLineRange,
	parseLsTree,
	type PullRequestInfo,
} from '@mng-review/domain'
import { Context, Effect, Layer, Predicate, Result, Schema } from 'effect'
import { GitService } from '../../../../platform/git/git.service'
import { truncateText } from '../../../../utils/fence.util'
import { toOutputPage } from '../../domain/output-part.helper'
import {
	BYTES_PER_KB,
	MAX_GREP_PER_FILE,
	MAX_TOOL_OUTPUT_CHARS,
} from '../../domain/review.constants'
import { ToolError } from '../../domain/review.errors'
import {
	addGrepMatch,
	addNumberedLine,
} from '../../infrastructure/tool-output.parser'
import { getDiffParts } from '../read-coverage.helper'
import type { ToolRef, ToolResult } from '../repo-tools.types'
import {
	BlameTool,
	DiffTool,
	GrepTool,
	ListDirTool,
	PrMetadataTool,
	ReadFileTool,
	REPO_TOOLS,
	type RepoToolName,
} from '../repo.toolkit'
import { ReviewLimits } from '../review-limits.context'

/** What the tools of one run read: the change, with its left-out files marked, and the pull request. */
export interface RepoScope {
	readonly change: Change
	readonly pr: PullRequestInfo
}

/**
 * Read-only repository tools. Every answer is text; a problem (a bad path, a missing file, a git
 * failure) comes back as `error: …`, never as a failed effect. Output is cut to
 * `MAX_TOOL_OUTPUT_CHARS`, the cut marker included. `run` also says which lines a `read_file`
 * showed; `call` gives the text alone.
 */
export class RepoToolsService extends Context.Service<
	RepoToolsService,
	{
		readonly run: (
			scope: RepoScope,
			name: string,
			params: unknown
		) => Effect.Effect<ToolResult>
		readonly call: (
			scope: RepoScope,
			name: string,
			params: unknown
		) => Effect.Effect<string>
	}
>()('mng-review/RepoToolsService') {}

/** Longest path, pattern or glob a tool passes to git; Linux refuses a single argument over 128 KB. */
const MAX_ARGUMENT_CHARS = 4096

/** A repository-relative path, or `.` for the root when `root` allows it. */
function requirePath(value: string, root: boolean) {
	if (value.length > MAX_ARGUMENT_CHARS)
		return Effect.fail(new ToolError({ reason: 'path is too long' }))
	const path = normalizeRepoPath(value)
	if (path === undefined || (path === '.' && !root))
		return Effect.fail(
			new ToolError({
				reason: root
					? 'path must be inside the repository'
					: 'path must be a file path inside the repository',
			})
		)
	return Effect.succeed(path)
}

/** A parsed range, or the reason the text is not one. */
function requireRange(value: string | undefined) {
	return Result.match(parseLineRange(value), {
		onSuccess: Effect.succeed,
		onFailure: reason => Effect.fail(new ToolError({ reason })),
	})
}

/** Globs stay inside the repository: no leading `/`, no `..`, no backslash or NUL. */
function requireGlob(glob: string | undefined) {
	if (glob === undefined || glob === '') return Effect.succeed(undefined)
	if (glob.length > MAX_ARGUMENT_CHARS)
		return Effect.fail(new ToolError({ reason: 'glob is too long' }))
	if (glob.startsWith('/') || glob.includes('..') || /[\\\0]/u.test(glob))
		return Effect.fail(
			new ToolError({ reason: 'glob must be a repository-relative pattern' })
		)
	return Effect.succeed(glob)
}

/** A part of a diff and the characters of each file's section it holds. */
function toDiffResult(text: string, offset: number | undefined): ToolResult {
	if (text === '') return { output: '(no changes)' }
	const page = toOutputPage(text, offset)
	return { output: page.output, diff: getDiffParts(text, page.start, page.end) }
}

/** The commit a tool ref names: the head, or the merge base for `base`. */
function toCommit(scope: RepoScope, ref: ToolRef): string {
	return ref === 'head' ? scope.change.head.commit : scope.change.mergeBase
}

export const RepoToolsServiceLive = Layer.effect(
	RepoToolsService,
	Effect.gen(function* () {
		const git = yield* GitService
		const { maxFileKb } = yield* ReviewLimits

		const gitText = (args: readonly string[]) =>
			git.exec(args).pipe(
				Effect.flatMap(result =>
					result.exitCode === 0
						? Effect.succeed(result.stdout)
						: Effect.fail(
								new ToolError({
									reason: result.stderr.trim() || `git ${args[0]} failed`,
								})
							)
				)
			)

		const readFile = Effect.fn('RepoToolsService.readFile')(function* (
			scope: RepoScope,
			params: typeof ReadFileTool.parametersSchema.Type
		) {
			const path = yield* requirePath(params.path, false)
			const range = yield* requireRange(params.range)
			const commit = toCommit(scope, params.ref)
			const [entry] = parseLsTree(
				yield* gitText([
					'ls-tree',
					'-z',
					'-l',
					'--full-tree',
					commit,
					'--',
					path,
				])
			)
			if (entry?.name !== path)
				return yield* new ToolError({
					reason: `${path} does not exist at ${params.ref}`,
				})
			if (entry.type !== 'blob')
				return yield* new ToolError({ reason: `${path} is not a file` })
			if (!range && (entry.size ?? 0) > maxFileKb * BYTES_PER_KB)
				return yield* new ToolError({
					reason: `${path} is larger than ${maxFileKb} KB; pass a range`,
				})
			const { exitCode, stderr, state } = yield* git.foldLines(
				['show', '--no-textconv', `${commit}:${path}`],
				{
					initial: { text: '', seen: 0, binary: false, whole: 0 },
					maxLineChars: MAX_TOOL_OUTPUT_CHARS,
					step: addNumberedLine(range),
				}
			)
			if (exitCode !== 0)
				return yield* new ToolError({
					reason: stderr.trim() || 'git show failed',
				})
			if (state.binary)
				return yield* new ToolError({ reason: `${path} is a binary file` })
			const start = range?.start ?? 1
			const truncated = state.text.length > MAX_TOOL_OUTPUT_CHARS
			// Uncut, every line of the range that exists was kept whole.
			const end = truncated
				? state.whole
				: Math.min(range?.end ?? state.seen, state.seen)
			if (end < start) return state.text || '(no lines in range)'
			return {
				output: state.text,
				shown: { ref: params.ref, path, lines: { start, end }, truncated },
			} satisfies ToolResult
		})

		const grep = Effect.fn('RepoToolsService.grep')(function* (
			scope: RepoScope,
			params: typeof GrepTool.parametersSchema.Type
		) {
			if (params.pattern === '')
				return yield* new ToolError({ reason: 'pattern is required' })
			if (params.pattern.length > MAX_ARGUMENT_CHARS)
				return yield* new ToolError({ reason: 'pattern is too long' })
			const glob = yield* requireGlob(params.glob)
			const commit = toCommit(scope, params.ref)
			const args = [
				'grep',
				'-n',
				'-z',
				'-I',
				'-E',
				'--no-color',
				`--max-count=${MAX_GREP_PER_FILE}`,
				'-e',
				params.pattern,
				commit,
				'--',
			]
			const { exitCode, stderr, state } = yield* git.foldLines(args, {
				initial: { text: '', shown: 0, rest: 0 },
				maxLineChars: MAX_TOOL_OUTPUT_CHARS,
				step: addGrepMatch(commit, glob),
			})
			if (exitCode !== 0 && exitCode !== 1)
				return yield* new ToolError({ reason: stderr.trim() || 'grep failed' })
			if (state.shown === 0) return '(no matches)'
			const more = state.rest > 0 ? `\n[${state.rest} more matches]` : ''
			return `${state.text}${more}`
		})

		const listDir = Effect.fn('RepoToolsService.listDir')(function* (
			scope: RepoScope,
			params: typeof ListDirTool.parametersSchema.Type
		) {
			const path = yield* requirePath(params.path, true)
			const commit = toCommit(scope, params.ref)
			const result = yield* git.exec([
				'ls-tree',
				'-z',
				path === '.' ? commit : `${commit}:${path}`,
			])
			if (result.exitCode !== 0)
				return yield* new ToolError({
					reason: `${path} is not a directory at ${params.ref}`,
				})
			const entries = parseLsTree(result.stdout).map(entry =>
				entry.type === 'tree' ? `${entry.name}/` : entry.name
			)
			return entries.length > 0 ? entries.join('\n') : '(empty)'
		})

		const diff = Effect.fn('RepoToolsService.diff')(function* (
			scope: RepoScope,
			params: typeof DiffTool.parametersSchema.Type
		) {
			const { change } = scope
			if (params.path === undefined || params.path === '') {
				const files = getReviewableFiles(change.files)
				if (files.length === 0) return '(no reviewable files)'
				return toDiffResult(yield* git.readDiff(change, files), params.offset)
			}
			const path = yield* requirePath(params.path, false)
			const file = change.files.find(
				entry => entry.path === path || entry.oldPath === path
			)
			if (file?.skipped)
				return yield* new ToolError({
					reason: `${path} is left out of the review (${file.skipped})`,
				})
			if (!file) return '(no changes)'
			return toDiffResult(yield* git.readDiff(change, [file]), params.offset)
		})

		const blame = Effect.fn('RepoToolsService.blame')(function* (
			scope: RepoScope,
			params: typeof BlameTool.parametersSchema.Type
		) {
			const path = yield* requirePath(params.path, false)
			const range = yield* requireRange(params.range)
			if (!range)
				return yield* new ToolError({
					reason: 'range is required, e.g. "10-40"',
				})
			return yield* gitText([
				'blame',
				'--no-textconv',
				'--date=short',
				'-L',
				`${range.start},${range.end}`,
				scope.change.head.commit,
				'--',
				path,
			])
		})

		const prMetadata = Effect.fn('RepoToolsService.prMetadata')(function* (
			scope: RepoScope
		) {
			const { change, pr } = scope
			const log = yield* gitText([
				'log',
				'--no-color',
				'--format=%h %s',
				`${change.mergeBase}..${change.head.commit}`,
			])
			return JSON.stringify(
				{
					title: pr.title ?? null,
					description: pr.body ?? null,
					labels: pr.labels,
					author: pr.author ?? null,
					target: pr.target ?? null,
					base: change.base.ref,
					head: change.head.ref,
					commits: log.split('\n').filter(Boolean),
					files: change.files.map(file => ({
						path: file.path,
						...(file.oldPath ? { from: file.oldPath } : {}),
						status: file.status,
						additions: file.additions,
						deletions: file.deletions,
						...(file.skipped ? { left_out: file.skipped } : {}),
					})),
				},
				null,
				2
			)
		})

		/** Decodes the arguments with the tool's own schema and runs it. */
		const dispatch = (scope: RepoScope, name: string, params: unknown) => {
			const decode = <TParams>(schema: Schema.Codec<TParams, unknown>) =>
				Schema.decodeUnknownEffect(schema)(params ?? {}).pipe(
					Effect.mapError(
						error =>
							new ToolError({
								reason: `invalid arguments for ${name}: ${error.message}`,
							})
					)
				)
			const handlers = {
				[ReadFileTool.name]: () =>
					decode(ReadFileTool.parametersSchema).pipe(
						Effect.flatMap(args => readFile(scope, args))
					),
				[GrepTool.name]: () =>
					decode(GrepTool.parametersSchema).pipe(
						Effect.flatMap(args => grep(scope, args))
					),
				[ListDirTool.name]: () =>
					decode(ListDirTool.parametersSchema).pipe(
						Effect.flatMap(args => listDir(scope, args))
					),
				[DiffTool.name]: () =>
					decode(DiffTool.parametersSchema).pipe(
						Effect.flatMap(args => diff(scope, args))
					),
				[BlameTool.name]: () =>
					decode(BlameTool.parametersSchema).pipe(
						Effect.flatMap(args => blame(scope, args))
					),
				[PrMetadataTool.name]: () => prMetadata(scope),
			} satisfies Record<RepoToolName, unknown>
			const tool = REPO_TOOLS.find(entry => entry.name === name)
			if (!tool)
				return Effect.fail(new ToolError({ reason: `unknown tool ${name}` }))
			return handlers[tool.name]().pipe(
				Effect.map((result: string | ToolResult): ToolResult =>
					Predicate.isString(result) ? { output: result } : result
				)
			)
		}

		const run = Effect.fn('RepoToolsService.run')(function* (
			scope: RepoScope,
			name: string,
			params: unknown
		) {
			return yield* dispatch(scope, name, params).pipe(
				Effect.catch(error =>
					Effect.succeed({ output: `error: ${error.message}` })
				),
				Effect.map((result): ToolResult => ({
					...result,
					output: truncateText(result.output, MAX_TOOL_OUTPUT_CHARS),
				}))
			)
		})

		const call = Effect.fn('RepoToolsService.call')(function* (
			scope: RepoScope,
			name: string,
			params: unknown
		) {
			return (yield* run(scope, name, params)).output
		})

		return { run, call }
	})
)
