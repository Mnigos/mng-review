import { matchesAnyGlob } from '../../utils/glob.util'
import {
	BUILT_IN_FLOOR,
	BUILT_IN_FLOOR_DIRS,
	CODEOWNERS_PATHS,
	GIT_MODE,
	GITATTRIBUTES_NAME,
} from '../risk.constants'
import type {
	ConfiguredFloor,
	FloorDiff,
	FloorDiffFile,
	FloorHit,
	FloorReport,
	FloorSettings,
} from '../risk.types'

/** A built-in hit's name, one of `BUILT_IN_FLOOR`. */
type BuiltInFloorName = (typeof BUILT_IN_FLOOR)[keyof typeof BUILT_IN_FLOOR]

/** A side of a change that has a file: any mode but `000000` or a missing one. */
function hasMode(mode: string): boolean {
	return mode !== '' && mode !== GIT_MODE.NONE
}

/**
 * The built-in floors one file hits. Paths compare without case, so a case-insensitive checkout
 * cannot hide `.GitHub/` or `CodeOwners`. A submodule, a symlink or a mode change hits wherever it
 * is, and so does a count that did not parse.
 */
export function getBuiltInFloors(
	file: FloorDiffFile,
	rulesPaths: readonly string[]
): BuiltInFloorName[] {
	const path = file.path.toLowerCase()
	const modes = new Set([file.oldMode, file.newMode])
	const checks = [
		[BUILT_IN_FLOOR.GITHUB, matchesAnyGlob(path, [BUILT_IN_FLOOR_DIRS[0]])],
		[BUILT_IN_FLOOR.MNG, matchesAnyGlob(path, [BUILT_IN_FLOOR_DIRS[1]])],
		[BUILT_IN_FLOOR.CODEOWNERS, CODEOWNERS_PATHS.some(entry => entry === path)],
		[
			BUILT_IN_FLOOR.GITATTRIBUTES,
			path.split('/').at(-1) === GITATTRIBUTES_NAME,
		],
		[
			BUILT_IN_FLOOR.RULES,
			rulesPaths.some(entry => entry.toLowerCase() === path),
		],
		[BUILT_IN_FLOOR.SUBMODULE, modes.has(GIT_MODE.GITLINK)],
		[BUILT_IN_FLOOR.SYMLINK, modes.has(GIT_MODE.SYMLINK)],
		[
			BUILT_IN_FLOOR.MODE,
			hasMode(file.oldMode) &&
				hasMode(file.newMode) &&
				file.oldMode !== file.newMode,
		],
		[BUILT_IN_FLOOR.UNKNOWN_COUNT, file.count === 'unknown'],
	] as const satisfies readonly (readonly [BuiltInFloorName, boolean])[]
	return checks.filter(([, hit]) => hit).map(([name]) => name)
}

/** True when a configured floor covers the path: one of its globs matches and no exclude does. */
function isUnderFloor(path: string, floor: ConfiguredFloor): boolean {
	return (
		matchesAnyGlob(path, floor.paths) && !matchesAnyGlob(path, floor.exclude)
	)
}

/** The hit for the files under one floor, with their lines summed; binaries and unknowns add none. */
function toFloorHit(
	floor: Pick<FloorHit, 'name' | 'level' | 'builtIn'>,
	files: readonly FloorDiffFile[]
): FloorHit {
	const lines = files.map(file =>
		typeof file.count === 'string' ? { added: 0, deleted: 0 } : file.count
	)
	return {
		...floor,
		paths: files.map(file => file.path),
		added: lines.reduce((sum, count) => sum + count.added, 0),
		deleted: lines.reduce((sum, count) => sum + count.deleted, 0),
	}
}

/**
 * The floors the complete change hits and its binaries outside `risk.assets`. Every built-in hit
 * is High; a diff that did not parse whole hits `built-in:unparsed` with no paths. Each path counts
 * on its own, so a rename counts at its old and its new path.
 */
export function getFloorReport(
	diff: FloorDiff,
	settings: FloorSettings
): FloorReport {
	const named = diff.files.map(file => ({
		file,
		names: getBuiltInFloors(file, settings.rulesPaths),
	}))
	const builtIn = Object.values(BUILT_IN_FLOOR).map(name =>
		toFloorHit(
			{ name, level: 'high', builtIn: true },
			named.filter(entry => entry.names.includes(name)).map(entry => entry.file)
		)
	)
	const configured = settings.floors.map(floor =>
		toFloorHit(
			{ name: floor.name, level: floor.level, builtIn: false },
			diff.files.filter(file => isUnderFloor(file.path, floor))
		)
	)
	const hits = [...builtIn, ...configured].filter(
		hit =>
			hit.paths.length > 0 ||
			(hit.name === BUILT_IN_FLOOR.UNPARSED && !diff.intact)
	)
	return {
		hits,
		opaque: diff.files
			.filter(
				file =>
					file.count === 'binary' && !matchesAnyGlob(file.path, settings.assets)
			)
			.map(file => file.path),
	}
}
