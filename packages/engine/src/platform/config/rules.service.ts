import {
	AGENTS_DIR,
	CONFIG_PATH,
	ConfigError,
	CONTEXT_PATH,
	type DeclaredAgent,
	extractSection,
	MEMORY_PATH,
	parseAgentFile,
	parseImportLine,
	parseReviewConfig,
	type ReviewConfig,
	toDeclaredAgent,
} from '@mng-review/domain'
import { Context, Effect, FileSystem, Layer, Path } from 'effect'
import type { GitError } from '../git/git.errors'
import { GitService } from '../git/git.service'
import {
	makeRefReader,
	makeWorktreeReader,
	type RepoReader,
} from './repo-reader.client'

const AGENT_EXTENSION = '.md'

/** The rules of a run: `review.yml` over its preset and the declared agents, imports expanded. */
export interface Rules {
	readonly config: ReviewConfig
	readonly agents: readonly DeclaredAgent[]
	/** `.mng/CONTEXT.md`, when the repository has one. */
	readonly context?: string
	/** `.mng/MEMORY.md`, when the repository has one. */
	readonly memory?: string
	/** `working tree` or the rules ref. */
	readonly source: string
}

/** Loads `.mng/` from the working tree, or from a commit when a rules ref is given. */
export class RulesService extends Context.Service<
	RulesService,
	{
		readonly load: (
			rulesRef: string | undefined
		) => Effect.Effect<Rules, ConfigError | GitError>
	}
>()('mng-review/RulesService') {}

/** Reads a file every caller needs; a read failure becomes a `ConfigError` naming `file`. */
function readNamed(reader: RepoReader, path: string, file: string) {
	return reader.readFile(path).pipe(
		Effect.catchTag('GitError', error =>
			Effect.fail(
				new ConfigError({
					source: file,
					reason: `cannot read ${path} from ${reader.source} (${error.message})`,
				})
			)
		)
	)
}

/** The text one import line stands for: the whole file, or the section under the heading. */
const expandImport = Effect.fn('RulesService.expandImport')(function* (
	line: string,
	reader: RepoReader,
	file: string
) {
	const found = yield* parseImportLine(line, file)
	if (!found) return line
	const importLine = line.trim()
	const text = yield* readNamed(reader, found.path, file)
	if (text === undefined)
		return yield* new ConfigError({
			source: file,
			reason: `import "${importLine}": ${found.path} not found in ${reader.source}`,
		})
	if (found.heading === undefined) return text.trimEnd()
	const section = extractSection(text, found.heading)
	if (section === undefined)
		return yield* new ConfigError({
			source: file,
			reason: `import "${importLine}": no heading "${found.heading}" in ${found.path}`,
		})
	return section
})

/**
 * Replaces each import line of an agent body with the file or section it names, read through the
 * same reader as the agent. Imported text is inserted as is; imports inside it stay as they are.
 * A missing file or heading, or a path outside the repository, fails with a `ConfigError`.
 */
export function expandImports(body: string, reader: RepoReader, file: string) {
	return Effect.forEach(body.split('\n'), line =>
		expandImport(line, reader, file)
	).pipe(Effect.map(lines => lines.join('\n')))
}

/** Parses one listed agent file; a listed file that cannot be read fails and names it. */
const loadAgent = Effect.fn('RulesService.loadAgent')(function* (
	reader: RepoReader,
	fileName: string
) {
	const file = `${AGENTS_DIR}/${fileName}`
	const text = yield* readNamed(reader, file, file)
	if (text === undefined)
		return yield* new ConfigError({
			source: file,
			reason: `listed in ${AGENTS_DIR} but cannot be read from ${reader.source}`,
		})
	const agentFile = yield* parseAgentFile(
		fileName.slice(0, -AGENT_EXTENSION.length),
		text,
		file
	)
	return yield* toDeclaredAgent(
		agentFile,
		yield* expandImports(agentFile.body, reader, file)
	)
})

/** Every `.mng/agents/*.md` file in name order; a missing directory means no declared agents. */
function loadAgents(reader: RepoReader) {
	return reader.listFiles(AGENTS_DIR).pipe(
		Effect.flatMap(names =>
			Effect.forEach(
				(names ?? []).filter(name => name.endsWith(AGENT_EXTENSION)),
				name => loadAgent(reader, name)
			)
		)
	)
}

export const RulesServiceLive = Layer.effect(
	RulesService,
	Effect.gen(function* () {
		const git = yield* GitService
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path

		const openReader = (rulesRef: string | undefined) =>
			rulesRef === undefined
				? makeWorktreeReader(git.root).pipe(
						Effect.provideService(FileSystem.FileSystem, fs),
						Effect.provideService(Path.Path, path)
					)
				: git
						.resolveCommit(rulesRef)
						.pipe(Effect.map(commit => makeRefReader(git, rulesRef, commit)))

		const load = Effect.fn('RulesService.load')(function* (
			rulesRef: string | undefined
		) {
			const reader = yield* openReader(rulesRef)
			const configText = yield* readNamed(reader, CONFIG_PATH, CONFIG_PATH)
			const config = yield* parseReviewConfig(configText, CONFIG_PATH)
			const agents = yield* loadAgents(reader)
			const context = yield* readNamed(reader, CONTEXT_PATH, CONTEXT_PATH)
			const memory = yield* readNamed(reader, MEMORY_PATH, MEMORY_PATH)
			return {
				config,
				agents,
				source: reader.source,
				...(context === undefined ? {} : { context }),
				...(memory === undefined ? {} : { memory }),
			}
		})

		return { load }
	})
)
