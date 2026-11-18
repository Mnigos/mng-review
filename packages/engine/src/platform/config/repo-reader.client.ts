import { ConfigError, normalizeRepoPath } from '@mng-review/domain'
import { Effect, FileSystem, Path, type PlatformError } from 'effect'
import type { GitError } from '../git/git.errors'
import type { GitService } from '../git/git.service'

/** Read failures a missing file never causes. */
type ReadError = ConfigError | GitError

/** Read access to `.mng/` files and their imports, in the working tree or at a commit. */
export interface RepoReader {
	/** Where the files come from, for messages: `working tree` or the rules ref. */
	readonly source: string
	/** File text, or `undefined` when the file does not exist. */
	readonly readFile: (
		path: string
	) => Effect.Effect<string | undefined, ReadError>
	/** Sorted names of the files directly inside a directory, or `undefined` when it does not exist. */
	readonly listFiles: (
		directory: string
	) => Effect.Effect<readonly string[] | undefined, ReadError>
}

export const WORKTREE_SOURCE = 'working tree'
/** Errors that mean "no such file here": a missing entry or a path through a file. */
const ABSENT_TAGS = ['NotFound', 'BadResource'] as const

/** The normalised repository-relative path, or a `ConfigError` for one outside the repository. */
function requireRepoPath(path: string): Effect.Effect<string, ConfigError> {
	const clean = normalizeRepoPath(path)
	if (clean === undefined || clean === '.')
		return Effect.fail(
			new ConfigError({ source: path, reason: 'path outside the repository' })
		)
	return Effect.succeed(clean)
}

/** True when the platform error means the path does not exist. */
function isAbsent(error: PlatformError.PlatformError): boolean {
	const { reason } = error
	return (
		reason._tag !== 'BadArgument' &&
		ABSENT_TAGS.some(tag => tag === reason._tag)
	)
}

/** Maps "not found" to `undefined` and every other failure to a `ConfigError` naming the path. */
function absentAsUndefined<TValue>(path: string) {
	return (effect: Effect.Effect<TValue, PlatformError.PlatformError>) =>
		effect.pipe(
			Effect.catchTag('PlatformError', error =>
				isAbsent(error)
					? Effect.succeed(undefined)
					: Effect.fail(
							new ConfigError({
								source: path,
								reason: `cannot be read (${error.message})`,
							})
						)
			)
		)
}

/**
 * Reads the working tree under `root`. Like git, names are case-exact: every component must
 * appear with that spelling in its directory, even on a case-insensitive file system. A path whose
 * real location (after symlinks) leaves the root is refused with a `ConfigError`.
 */
export const makeWorktreeReader = Effect.fn('makeWorktreeReader')(function* (
	root: string
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const realRoot = yield* fs.realPath(root).pipe(
		Effect.mapError(
			error =>
				new ConfigError({
					source: root,
					reason: `cannot be read (${error.message})`,
				})
		)
	)

	const hasExactNames = (
		directory: string,
		names: readonly string[]
	): Effect.Effect<boolean, ConfigError> => {
		const [name, ...rest] = names
		if (name === undefined) return Effect.succeed(true)
		return fs.readDirectory(directory).pipe(
			absentAsUndefined<string[]>(directory),
			Effect.flatMap(entries =>
				entries?.includes(name)
					? hasExactNames(path.join(directory, name), rest)
					: Effect.succeed(false)
			)
		)
	}

	/**
	 * The real path of a case-exact path inside the root, or `undefined` when it does not exist. A
	 * path that resolves outside the root fails, so a symlinked `review.yml` never silently gives
	 * the defaults.
	 */
	const resolveInside = (rawPath: string) =>
		Effect.gen(function* () {
			const clean = yield* requireRepoPath(rawPath)
			if (!(yield* hasExactNames(root, clean.split('/')))) return undefined
			const real = yield* fs
				.realPath(path.join(root, clean))
				.pipe(absentAsUndefined<string>(clean))
			if (real === undefined) return undefined
			if (real !== realRoot && !real.startsWith(realRoot + path.sep))
				return yield* new ConfigError({
					source: clean,
					reason: 'resolves outside the repository (symlink)',
				})
			return { clean, real }
		})

	const readFile = (rawPath: string) =>
		Effect.gen(function* () {
			const target = yield* resolveInside(rawPath)
			if (!target) return undefined
			return yield* fs
				.readFileString(target.real)
				.pipe(absentAsUndefined<string>(target.clean))
		})

	const listFiles = (rawPath: string) =>
		Effect.gen(function* () {
			const target = yield* resolveInside(rawPath)
			if (!target) return undefined
			const entries = yield* fs
				.readDirectoryEntries(target.real)
				.pipe(
					absentAsUndefined<readonly FileSystem.DirectoryEntry[]>(target.clean)
				)
			return entries
				?.filter(entry => entry.type === 'File')
				.map(entry => entry.name)
				.toSorted()
		})

	return { source: WORKTREE_SOURCE, readFile, listFiles } satisfies RepoReader
})

/** Reads files committed at `commit`, named `ref` in messages; the working tree is ignored. */
export function makeRefReader(
	git: GitService['Service'],
	ref: string,
	commit: string
): RepoReader {
	return {
		source: ref,
		readFile: rawPath =>
			requireRepoPath(rawPath).pipe(
				Effect.flatMap(clean => git.readFileAt(commit, clean))
			),
		listFiles: rawPath =>
			requireRepoPath(rawPath).pipe(
				Effect.flatMap(clean => git.listFilesAt(commit, clean))
			),
	}
}
