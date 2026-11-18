import {
	type Change,
	type ChangedFile,
	ConfigError,
	parseLsTree,
	parseNameStatus,
	parseNumstat,
	toBranchName,
	type TreeEntry,
} from '@mng-review/domain'
import { Array as Arr, Context, Effect, Layer, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { splitCappedLines } from '../../utils/capped-lines.util'
import {
	GIT_ENV,
	GIT_PREFIX,
	GITLINK_TYPE,
	PATHS_PER_CALL,
	SAFE_DIFF,
} from './git.constants'
import { GitError } from './git.errors'

/** The directory git runs in; its repository root is resolved when the service is built. */
export class GitWorkdir extends Context.Service<
	GitWorkdir,
	{ readonly cwd: string }
>()('mng-review/GitWorkdir') {}

/** Output of one git command. */
export interface GitResult {
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
}

/** How `foldLines` reduces stdout: a start state, a step per line and the longest line it keeps. */
export interface LineFold<TState> {
	readonly initial: TState
	readonly maxLineChars: number
	readonly step: (state: TState, line: string) => TState
}

/** A git command's exit code and stderr with its stdout folded into a state. */
export interface GitFoldResult<TState> extends Omit<GitResult, 'stdout'> {
	readonly state: TState
}

/** Reads a command's decoded stdout into a value. */
type StdoutReader<TOut> = <TError>(
	stdout: Stream.Stream<string, TError>
) => Effect.Effect<TOut, TError>

/** The merge base and head commit a diff runs between. */
type DiffRange = Pick<Change, 'mergeBase' | 'head'>

/** Read-only access to one repository. Nothing from the change is built or executed. */
export class GitService extends Context.Service<
	GitService,
	{
		/** The repository root, exactly as git prints it apart from the line terminator. */
		readonly root: string
		readonly resolveCommit: (
			ref: string
		) => Effect.Effect<string, ConfigError | GitError>
		readonly mergeBase: (
			base: string,
			head: string
		) => Effect.Effect<string, ConfigError | GitError>
		/** `origin/main` and `refs/heads/main` give `main`; tags and commits give `undefined`. */
		readonly branchName: (
			ref: string
		) => Effect.Effect<string | undefined, GitError>
		/** Changed files between the merge base of both refs and the head, with counts and sizes. */
		readonly readChange: (
			baseRef: string,
			headRef: string
		) => Effect.Effect<Change, ConfigError | GitError>
		/** Unified diff of the files; a rename or copy includes its old path. */
		readonly readDiff: (
			range: DiffRange,
			files: readonly ChangedFile[]
		) => Effect.Effect<string, GitError>
		/** Blob content at a commit; `undefined` for a missing path, a tree or a gitlink. */
		readonly readFileAt: (
			commit: string,
			path: string
		) => Effect.Effect<string | undefined, GitError>
		/** Runs a read-only git command at the root; the caller judges the exit code. */
		readonly exec: (
			args: readonly string[]
		) => Effect.Effect<GitResult, GitError>
		/** Like `exec`, but stdout is folded line by line while it streams and never held whole. */
		readonly foldLines: <TState>(
			args: readonly string[],
			fold: LineFold<TState>
		) => Effect.Effect<GitFoldResult<TState>, GitError>
		/** Sorted names of the files directly inside a directory; `undefined` when it is missing. */
		readonly listFilesAt: (
			commit: string,
			directory: string
		) => Effect.Effect<readonly string[] | undefined, GitError>
		/** The paths among `paths` that are files at the commit. */
		readonly getFilesAt: (
			commit: string,
			paths: readonly string[]
		) => Effect.Effect<ReadonlySet<string>, GitError>
	}
>()('mng-review/GitService') {}

/** Strips one trailing line terminator; any other whitespace belongs to the value. */
function stripLineEnd(text: string): string {
	return text.replace(/\r?\n$/u, '')
}

/** Paths of the files, a rename's or copy's old path first. */
function toDiffPaths(files: readonly ChangedFile[]): string[] {
	return files.flatMap(file =>
		file.oldPath === undefined ? [file.path] : [file.oldPath, file.path]
	)
}

/** The size of a changed file's tree entry: blobs need one, gitlinks have none and count 0. */
function toEntrySize(
	entry: TreeEntry | undefined,
	path: string,
	args: readonly string[]
): number | GitError {
	if (entry?.type === GITLINK_TYPE) return 0
	if (entry?.type === 'blob' && entry.size !== undefined) return entry.size
	return new GitError({
		args,
		exitCode: 0,
		stderr: entry
			? `no blob size for ${path} (${entry.type})`
			: `no tree entry for ${path}`,
	})
}

export const GitServiceLive = Layer.effect(
	GitService,
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const { cwd } = yield* GitWorkdir

		const spawn = <TOut>(
			dir: string,
			args: readonly string[],
			readStdout: StdoutReader<TOut>
		) =>
			Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* spawner.spawn(
						ChildProcess.make('git', [...GIT_PREFIX, ...args], {
							cwd: dir,
							env: GIT_ENV,
							extendEnv: true,
							stdin: 'ignore',
						})
					)
					const [stdout, stderr, exitCode] = yield* Effect.all(
						[
							readStdout(Stream.decodeText(handle.stdout)),
							Stream.mkString(Stream.decodeText(handle.stderr)),
							handle.exitCode,
						],
						{ concurrency: 'unbounded' }
					)
					return { exitCode, stdout, stderr }
				})
			).pipe(
				Effect.mapError(
					error => new GitError({ args, exitCode: -1, stderr: error.message })
				)
			)

		const run = (
			dir: string,
			args: readonly string[]
		): Effect.Effect<GitResult, GitError> => spawn(dir, args, Stream.mkString)

		const toplevel = yield* run(cwd, ['rev-parse', '--show-toplevel'])
		if (toplevel.exitCode !== 0)
			return yield* new ConfigError({
				source: cwd,
				reason: 'not inside a git repository',
			})
		const root = stripLineEnd(toplevel.stdout)

		const gitText = (args: readonly string[]) =>
			run(root, args).pipe(
				Effect.flatMap(result =>
					result.exitCode === 0
						? Effect.succeed(result.stdout)
						: Effect.fail(
								new GitError({
									args,
									exitCode: result.exitCode,
									stderr: result.stderr,
								})
							)
				)
			)

		const resolveCommit = Effect.fn('GitService.resolveCommit')(function* (
			ref: string
		) {
			if (ref.startsWith('-') || ref.trim() === '')
				return yield* new ConfigError({
					source: 'git',
					reason: `invalid ref "${ref}"`,
				})
			const result = yield* run(root, [
				'rev-parse',
				'--verify',
				'--quiet',
				'--end-of-options',
				`${ref}^{commit}`,
			])
			if (result.exitCode !== 0)
				return yield* new ConfigError({
					source: 'git',
					reason: `unknown ref "${ref}"`,
				})
			return stripLineEnd(result.stdout)
		})

		const mergeBase = Effect.fn('GitService.mergeBase')(function* (
			base: string,
			head: string
		) {
			const result = yield* run(root, ['merge-base', base, head])
			if (result.exitCode !== 0)
				return yield* new ConfigError({
					source: 'git',
					reason: `no merge base between ${base} and ${head}`,
				})
			return stripLineEnd(result.stdout)
		})

		const branchName = Effect.fn('GitService.branchName')(function* (
			ref: string
		) {
			if (ref.startsWith('-')) return undefined
			// `--end-of-options` would be printed here; refs starting with `-` are refused above.
			const result = yield* run(root, [
				'rev-parse',
				'--symbolic-full-name',
				ref,
			])
			if (result.exitCode !== 0) return undefined
			return toBranchName(stripLineEnd(result.stdout))
		})

		/** Tree entries of the paths at a commit, by path. */
		const readEntries = (commit: string, paths: readonly string[]) =>
			Effect.forEach(Arr.chunksOf(paths, PATHS_PER_CALL), chunk =>
				gitText(['ls-tree', '-z', '-l', '--full-tree', commit, '--', ...chunk])
			).pipe(
				Effect.map(
					outputs =>
						new Map(
							outputs.flatMap(output =>
								parseLsTree(output).map(entry => [entry.name, entry] as const)
							)
						)
				)
			)

		const readSizes = Effect.fn('GitService.readSizes')(function* (
			commit: string,
			paths: readonly string[]
		) {
			const entries = yield* readEntries(commit, paths)
			const args = ['ls-tree', '-l', commit]
			const sizes = new Map<string, number>()
			for (const path of paths) {
				const size = toEntrySize(entries.get(path), path, args)
				if (size instanceof GitError) return yield* size
				sizes.set(path, size)
			}
			return sizes
		})

		const readChange = Effect.fn('GitService.readChange')(function* (
			baseRef: string,
			headRef: string
		) {
			const [base, head] = yield* Effect.all(
				[resolveCommit(baseRef), resolveCommit(headRef)],
				{ concurrency: 2 }
			)
			const commonBase = yield* mergeBase(base, head)
			const range = [...SAFE_DIFF, commonBase, head]
			const [nameStatus, numstat] = yield* Effect.all(
				[
					gitText(['diff', '--name-status', '-z', ...range]),
					gitText(['diff', '--numstat', '-z', ...range]),
				],
				{ concurrency: 2 }
			)
			const counts = parseNumstat(numstat)
			const changed = parseNameStatus(nameStatus)
			const sizes = yield* readSizes(
				head,
				changed.filter(file => file.status !== 'deleted').map(file => file.path)
			)
			const files = changed.map(file => ({
				...file,
				...counts.get(file.path),
				sizeBytes: sizes.get(file.path) ?? 0,
			}))
			return {
				base: { ref: baseRef, commit: base },
				head: { ref: headRef, commit: head },
				mergeBase: commonBase,
				files,
			}
		})

		const readDiff = Effect.fn('GitService.readDiff')(function* (
			range: DiffRange,
			files: readonly ChangedFile[]
		) {
			if (files.length === 0) return ''
			return yield* gitText([
				'diff',
				...SAFE_DIFF,
				range.mergeBase,
				range.head.commit,
				'--',
				...toDiffPaths(files),
			])
		})

		const readFileAt = Effect.fn('GitService.readFileAt')(function* (
			commit: string,
			path: string
		) {
			const [entry] = parseLsTree(
				yield* gitText(['ls-tree', '-z', '--full-tree', commit, '--', path])
			)
			if (entry?.name !== path || entry.type !== 'blob') return undefined
			return yield* gitText(['show', '--no-textconv', `${commit}:${path}`])
		})

		const listFilesAt = Effect.fn('GitService.listFilesAt')(function* (
			commit: string,
			directory: string
		) {
			const entries = parseLsTree(
				yield* gitText([
					'ls-tree',
					'-z',
					'--full-tree',
					commit,
					'--',
					`${directory}/`,
				])
			)
			if (entries.length === 0) return undefined
			const prefix = `${directory}/`
			return entries
				.filter(entry => entry.type === 'blob' && entry.name.startsWith(prefix))
				.map(entry => entry.name.slice(prefix.length))
				.toSorted()
		})

		const getFilesAt = Effect.fn('GitService.getFilesAt')(function* (
			commit: string,
			paths: readonly string[]
		) {
			const entries = yield* readEntries(commit, paths)
			return new Set(paths.filter(path => entries.get(path)?.type === 'blob'))
		})

		return {
			root,
			exec: (args: readonly string[]) => run(root, args),
			foldLines: <TState>(args: readonly string[], fold: LineFold<TState>) =>
				spawn(root, args, stdout =>
					Stream.runFold(
						splitCappedLines(stdout, fold.maxLineChars),
						() => fold.initial,
						fold.step
					)
				).pipe(
					Effect.map(({ stdout, ...result }) => ({ ...result, state: stdout }))
				),
			resolveCommit,
			mergeBase,
			branchName,
			readChange,
			readDiff,
			readFileAt,
			listFilesAt,
			getFilesAt,
		}
	})
)
