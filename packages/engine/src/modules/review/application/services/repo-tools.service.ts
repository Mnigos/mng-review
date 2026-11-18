import {
	type Change,
	getReviewableFiles,
	type LineRange,
	matchesGlob,
	normalizeRepoPath,
	parseLineRange,
	parseLsTree,
	type PullRequestInfo,
} from '@mng-review/domain'
import { Context, Effect, Layer, Result, Schema } from 'effect'
import { GitService } from '../../../../platform/git/git.service'
import { truncateText } from '../../../../utils/fence.util'
import {
	BYTES_PER_KB,
	MAX_GREP_LINES,
	MAX_GREP_PER_FILE,
	MAX_TOOL_OUTPUT_CHARS,
} from '../../domain/review.constants'
import { ToolError } from '../../domain/review.errors'
import {
	BlameTool,
	DiffTool,
	GrepTool,
	ListDirTool,
	PrMetadataTool,
	ReadFileTool,
	REPO_TOOLS,
	type RepoToolName,
	type TOOL_REFS,
} from '../repo.toolkit'
import { ReviewLimits } from '../review-limits.context'

/** What the tools of one run read: the change, with its left-out files marked, and the pull request. */
export interface RepoScope {
	readonly change: Change
	readonly pr: PullRequestInfo
}

type ToolRef = (typeof TOOL_REFS)[number]

/**
 * Read-only repository tools. Every answer is text; a problem (a bad path, a missing file, a git
 * failure) comes back as `error: …`, never as a failed effect. Output is cut to
 * `MAX_TOOL_OUTPUT_CHARS`, the cut marker included.
 */
export class RepoToolsService extends Context.Service<
	RepoToolsService,
	{
		readonly call: (
			scope: RepoScope,
			name: string,
			params: unknown
		) => Effect.Effect<string>
	}
>()('mng-review/RepoToolsService') {}

/** A repository-relative path, or `.` for the root when `root` allows it. */
function requirePath(value: string, root: boolean) {
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
	if (glob.startsWith('/') || glob.includes('..') || /[\\\0]/u.test(glob))
		return Effect.fail(
			new ToolError({ reason: 'glob must be a repository-relative pattern' })
		)
	return Effect.succeed(glob)
}

/** The commit a tool ref names: the head, or the merge base for `base`. */
function toCommit(scope: RepoScope, ref: ToolRef): string {
	return ref === 'head' ? scope.change.head.commit : scope.change.mergeBase
}

/** Lines with their numbers, `start` to `end`, cut to the file. */
function toNumberedLines(text: string, range: LineRange | undefined): string {
	const lines = text.split('\n')
	const start = range?.start ?? 1
	const end = Math.min(range?.end ?? lines.length, lines.length)
	const shown = lines
		.slice(start - 1, end)
		.map((line, index) => `${start + index}| ${line}`)
	return shown.length > 0 ? shown.join('\n') : '(no lines in range)'
}

/** `git grep -z` records as `path:line:text`, kept to the glob and to `MAX_GREP_LINES`. */
function toGrepLines(output: string, commit: string, glob: string | undefined) {
	const prefix = `${commit}:`
	const matches = output
		.split('\n')
		.filter(Boolean)
		.map(record => record.split('\0'))
		.map(([file = '', line = '', ...text]) => ({
			path: file.startsWith(prefix) ? file.slice(prefix.length) : file,
			text: `${line}:${text.join('\0')}`,
		}))
		.filter(match => glob === undefined || matchesGlob(match.path, glob))
	if (matches.length === 0) return '(no matches)'
	const shown = matches
		.slice(0, MAX_GREP_LINES)
		.map(match => `${match.path}:${match.text}`)
	const rest = matches.length - shown.length
	return [...shown, ...(rest > 0 ? [`[${rest} more matches]`] : [])].join('\n')
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
			const text = yield* gitText([
				'show',
				'--no-textconv',
				`${commit}:${path}`,
			])
			if (text.includes('\0'))
				return yield* new ToolError({ reason: `${path} is a binary file` })
			return toNumberedLines(text, range)
		})

		const grep = Effect.fn('RepoToolsService.grep')(function* (
			scope: RepoScope,
			params: typeof GrepTool.parametersSchema.Type
		) {
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
			const result = yield* git.exec(args)
			if (result.exitCode === 1) return '(no matches)'
			if (result.exitCode !== 0)
				return yield* new ToolError({
					reason: result.stderr.trim() || 'grep failed',
				})
			return toGrepLines(result.stdout, commit, glob)
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
				return (yield* git.readDiff(change, files)) || '(no changes)'
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
			return (yield* git.readDiff(change, [file])) || '(no changes)'
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
			return handlers[tool.name]()
		}

		const call = Effect.fn('RepoToolsService.call')(function* (
			scope: RepoScope,
			name: string,
			params: unknown
		) {
			return yield* dispatch(scope, name, params).pipe(
				Effect.map(output => truncateText(output, MAX_TOOL_OUTPUT_CHARS)),
				Effect.catch(error => Effect.succeed(`error: ${error.message}`))
			)
		})

		return { call }
	})
)
