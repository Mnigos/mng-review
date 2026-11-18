import { posix } from 'node:path'

/** The closed naming table from AGENTS.md; `command`, `formatter`, `prompt`, `tool` and `toolkit` are this repository's additions (ADR 0003). */
export const ROLE_SUFFIXES = [
	'base',
	'client',
	'command',
	'config',
	'constants',
	'context',
	'contract',
	'errors',
	'formatter',
	'handler',
	'helper',
	'layer',
	'layers',
	'mapper',
	'middleware',
	'parser',
	'port',
	'prompt',
	'query',
	'repository',
	'router',
	'runtime',
	'schema',
	'schemas',
	'service',
	'tool',
	'toolkit',
	'types',
	'util',
] as const

export type RoleSuffix = (typeof ROLE_SUFFIXES)[number]

const ROLE = `(${ROLE_SUFFIXES.join('|')})`
/** One or two roles, e.g. `finding.schema.ts` or `finding.schema.types.ts` (the types of the finding schema), and the spec of either. */
const ROLE_FILE_PATTERN = new RegExp(
	String.raw`^[a-z0-9]+(?:-[a-z0-9]+)*\.${ROLE}(?:\.${ROLE})?(?:\.spec)?\.ts$`,
	'u'
)

export interface FilePath {
	path: string
	basename: string
	directory: string
}

export function toFilePath(filename: string): FilePath {
	const path = filename.replaceAll('\\', '/')

	return {
		path,
		basename: posix.basename(path),
		directory: posix.dirname(path),
	}
}

export function hasSegment({ path }: FilePath, segment: string): boolean {
	return path.includes(`/${segment}/`) || path.startsWith(`${segment}/`)
}

/** Every role in the name, in order: `finding.schema.types.ts` gives `['schema', 'types']`. */
export function getRoleSuffixes({ basename }: FilePath): string[] {
	const match = ROLE_FILE_PATTERN.exec(basename)

	return match ? match.slice(1).filter(role => role !== undefined) : []
}

/** The last role, which says what the file is: `types` for `finding.schema.types.ts`. */
export function getRoleSuffix(file: FilePath): string | undefined {
	return getRoleSuffixes(file).at(-1)
}
