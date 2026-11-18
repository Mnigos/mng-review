import {
	AGENTS_DIR,
	CONFIG_PATH,
	type ConfigError,
	MACROSCOPE_AGENTS_DIR,
	MACROSCOPE_APPROVABILITY_PATH,
	MACROSCOPE_CORRECTNESS_PATH,
	MACROSCOPE_DIR,
	type MacroscopeFile,
	parseAgentFile,
	parseReviewConfig,
	RULES_DIR,
	type RulesDraft,
	type RulesFile,
	STARTER_FILES,
	toDeclaredAgent,
	toMacroscopeRules,
} from '@mng-review/domain'
import {
	Context,
	Effect,
	FileSystem,
	Layer,
	Path,
	type PlatformError,
} from 'effect'
import {
	makeWorktreeReader,
	type RepoReader,
} from '../../../platform/config/repo-reader.client'
import { expandImports } from '../../../platform/config/rules.service'
import type { GitError } from '../../../platform/git/git.errors'
import { GitService } from '../../../platform/git/git.service'
import type { InitReport, WrittenFile } from '../domain/init-report.types'
import { InitError } from '../domain/init.errors'

/** What `mng-review init` is asked to do. */
export interface InitOptions {
	/** Build `.mng/` from `.macroscope/` instead of the starter files. */
	readonly fromMacroscope: boolean
	/** Write over an existing `.mng/`. */
	readonly force: boolean
}

const MARKDOWN_EXTENSION = '.md'

/** Writes a starter `.mng/`, or one built from `.macroscope/`, at the repository root. */
export class InitService extends Context.Service<
	InitService,
	{
		readonly init: (
			options: InitOptions
		) => Effect.Effect<InitReport, InitError | ConfigError | GitError>
	}
>()('mng-review/InitService') {}

/** Reads one Macroscope file, or `undefined` when it does not exist. */
function readMacroscopeFile(reader: RepoReader, path: string) {
	return reader
		.readFile(path)
		.pipe(
			Effect.map(text =>
				text === undefined
					? undefined
					: ({ path, text } satisfies MacroscopeFile)
			)
		)
}

/** Reads `.macroscope/` from the working tree; a missing folder or one with nothing to import fails. */
const readMacroscope = Effect.fn('InitService.readMacroscope')(function* (
	reader: RepoReader
) {
	if ((yield* reader.listFiles(MACROSCOPE_DIR)) === undefined)
		return yield* new InitError({
			reason: `no ${MACROSCOPE_DIR}/ folder at the repository root`,
		})
	const correctness = yield* readMacroscopeFile(
		reader,
		MACROSCOPE_CORRECTNESS_PATH
	)
	const approvability = yield* readMacroscopeFile(
		reader,
		MACROSCOPE_APPROVABILITY_PATH
	)
	const names = (yield* reader.listFiles(MACROSCOPE_AGENTS_DIR)) ?? []
	const agents = yield* Effect.forEach(
		names.filter(name => name.endsWith(MARKDOWN_EXTENSION)),
		name => readMacroscopeFile(reader, `${MACROSCOPE_AGENTS_DIR}/${name}`)
	)
	const agentFiles = agents.filter(file => file !== undefined)
	if (!(correctness || approvability || agentFiles.length > 0))
		return yield* new InitError({
			reason: `nothing to import in ${MACROSCOPE_DIR}/: no correctness/correctness.md, approvability.md or check-run-agents/*.md`,
		})
	return {
		...(correctness ? { correctness } : {}),
		...(approvability ? { approvability } : {}),
		agents: agentFiles,
	}
})

/**
 * Loads every generated `review.yml` and agent file as `RulesService` would, imports expanded
 * from the working tree, so `init` never writes rules that fail to load.
 */
const checkDraft = Effect.fn('InitService.checkDraft')(function* (
	draft: RulesDraft,
	reader: RepoReader
) {
	for (const file of draft.files) {
		if (file.path === CONFIG_PATH)
			yield* parseReviewConfig(file.text, file.path)
		if (file.path.startsWith(`${AGENTS_DIR}/`)) {
			const agentFile = yield* parseAgentFile(
				file.path.slice(AGENTS_DIR.length + 1, -MARKDOWN_EXTENSION.length),
				file.text,
				file.path
			)
			yield* toDeclaredAgent(
				agentFile,
				yield* expandImports(agentFile.body, reader, file.path)
			)
		}
	}
})

/** `.mng`, `.mng/agents` and the file itself for each file `init` writes, without repeats. */
function getWritePaths(files: readonly RulesFile[]): string[] {
	const paths = files.flatMap(file =>
		file.path
			.split('/')
			.map((_, index, parts) => parts.slice(0, index + 1).join('/'))
	)
	return [...new Set(paths)]
}

/** Turns a file system failure on `target` into an `InitError` naming it. */
function toWriteError(target: string) {
	return (error: PlatformError.PlatformError) =>
		new InitError({ reason: `cannot write ${target} (${error.message})` })
}

export const InitServiceLive = Layer.effect(
	InitService,
	Effect.gen(function* () {
		const git = yield* GitService
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path

		/**
		 * Refuses a symlink anywhere on the way to a file `init` writes, so `--force` never writes
		 * through a link into `.macroscope/` or out of the repository.
		 */
		const checkTargets = Effect.fn('InitService.checkTargets')(function* (
			files: readonly RulesFile[]
		) {
			for (const relative of getWritePaths(files)) {
				// readLink succeeds only on a link, dangling ones included, which exists() would miss.
				const isLink = yield* fs.readLink(path.join(git.root, relative)).pipe(
					Effect.as(true),
					Effect.orElseSucceed(() => false)
				)
				if (isLink)
					return yield* new InitError({
						reason: `${relative} is a symlink; init writes only plain files and folders inside the repository`,
					})
			}
			return yield* Effect.void
		})

		const writeFile = Effect.fn('InitService.writeFile')(function* (
			file: RulesFile
		) {
			const target = path.join(git.root, file.path)
			const existed = yield* fs
				.exists(target)
				.pipe(Effect.mapError(toWriteError(file.path)))
			yield* fs
				.makeDirectory(path.dirname(target), { recursive: true })
				.pipe(Effect.mapError(toWriteError(file.path)))
			yield* fs
				.writeFileString(target, file.text)
				.pipe(Effect.mapError(toWriteError(file.path)))
			return {
				path: file.path,
				status: existed ? 'overwritten' : 'created',
			} satisfies WrittenFile
		})

		const init = Effect.fn('InitService.init')(function* (
			options: InitOptions
		) {
			const exists = yield* fs
				.exists(path.join(git.root, RULES_DIR))
				.pipe(Effect.mapError(toWriteError(RULES_DIR)))
			if (exists && !options.force)
				return yield* new InitError({
					reason: `${RULES_DIR}/ already exists; pass --force to write over its files`,
				})
			const reader = yield* makeWorktreeReader(git.root).pipe(
				Effect.provideService(FileSystem.FileSystem, fs),
				Effect.provideService(Path.Path, path)
			)
			const draft: RulesDraft = options.fromMacroscope
				? yield* readMacroscope(reader).pipe(Effect.flatMap(toMacroscopeRules))
				: { files: STARTER_FILES, agents: [], notes: [] }
			yield* checkDraft(draft, reader)
			yield* checkTargets(draft.files)
			const files = yield* Effect.all(draft.files.map(file => writeFile(file)))
			return {
				root: git.root,
				source: options.fromMacroscope ? 'macroscope' : 'starter',
				files,
				agents: draft.agents,
				notes: draft.notes,
			} satisfies InitReport
		})

		return { init }
	})
)
