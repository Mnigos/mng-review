import type { FloorCount, FloorDiff, FloorDiffFile } from './risk.types'

/** A `--raw` record's header: both modes, both objects, the status letter and its score. */
const RAW_HEADER =
	/^:([0-7]{6}) ([0-7]{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])([0-9]{0,3})$/u
/** A line count `--numstat` prints: digits only. */
const LINE_COUNT = /^[0-9]+$/u
const BINARY_COUNT = '-'
/** The statuses `--raw` prints for a two-tree diff; anything else is out of shape. */
const KNOWN_STATUSES: ReadonlySet<string> = new Set([
	'A',
	'C',
	'D',
	'M',
	'R',
	'T',
])
/** The modes git writes for an absent file, a regular file, an executable, a symlink and a submodule. */
const KNOWN_MODES: ReadonlySet<string> = new Set([
	'000000',
	'100644',
	'100755',
	'120000',
	'160000',
])
/** Statuses whose records carry two paths, the old one first. */
const TWO_PATH_STATUSES: ReadonlySet<string> = new Set(['R', 'C'])

/** One `--raw` record: the modes, the status and the one or two paths it names. */
interface RawRecord {
	readonly oldMode: string
	readonly newMode: string
	readonly status: string
	readonly paths: readonly string[]
}

/** One `--numstat` record: the count and the one or two paths it names. */
interface CountRecord {
	readonly count: FloorCount
	readonly paths: readonly string[]
}

/** Records read so far and where the next one starts. */
interface ScanState {
	index: number
	intact: boolean
	readonly raw: RawRecord[]
	readonly counts: CountRecord[]
}

/** The fields of a `-z` output; the trailing NUL gives an empty last field, which is dropped. */
function toFields(output: string): string[] {
	const fields = output.split('\0')
	return fields.at(-1) === '' ? fields.slice(0, -1) : fields
}

/** Lines when both counts are digits, `binary` when both are `-`, `unknown` otherwise. */
function toFloorCount(added: string, deleted: string): FloorCount {
	if (added === BINARY_COUNT && deleted === BINARY_COUNT) return 'binary'
	if (!(LINE_COUNT.test(added) && LINE_COUNT.test(deleted))) return 'unknown'
	const totals = { added: Number(added), deleted: Number(deleted) }
	return Number.isSafeInteger(totals.added) &&
		Number.isSafeInteger(totals.deleted)
		? totals
		: 'unknown'
}

/** Reads the raw record at the cursor; false when its status, modes or paths are out of shape. */
function readRaw(fields: readonly string[], state: ScanState): boolean {
	const [, oldMode = '', newMode = '', status = ''] =
		RAW_HEADER.exec(fields[state.index] ?? '') ?? []
	if (
		!KNOWN_STATUSES.has(status) ||
		!KNOWN_MODES.has(oldMode) ||
		!KNOWN_MODES.has(newMode)
	)
		return false
	const width = TWO_PATH_STATUSES.has(status) ? 2 : 1
	const paths = fields.slice(state.index + 1, state.index + 1 + width)
	if (paths.length < width) return false
	state.raw.push({ oldMode, newMode, status, paths })
	state.index += 1 + width
	return true
}

/**
 * Reads the numstat record at the cursor; false when it has no two tabs. A record with an empty
 * path is a rename or copy, whose old and new paths follow as fields.
 */
function readCount(fields: readonly string[], state: ScanState): boolean {
	const [added, deleted, ...rest] = (fields[state.index] ?? '').split('\t')
	if (added === undefined || deleted === undefined || rest.length === 0)
		return false
	const path = rest.join('\t')
	const paths =
		path === '' ? fields.slice(state.index + 1, state.index + 3) : [path]
	if (path === '' && paths.length < 2) return false
	state.counts.push({ count: toFloorCount(added, deleted), paths })
	state.index += path === '' ? 3 : 1
	return true
}

/** The key two records about the same paths share. */
function toPathKey(paths: readonly string[]): string {
	return paths.join('\0')
}

/** One file per path of a raw record; a two-path record's paths share its count. */
function toFiles(record: RawRecord, count: FloorCount): FloorDiffFile[] {
	return record.paths.map(path => ({
		path,
		status: record.status,
		oldMode: record.oldMode,
		newMode: record.newMode,
		count,
	}))
}

/**
 * Parses `git diff --no-renames --raw --numstat -z`: the raw records first, then one count per
 * record. A rename or copy record, which `--no-renames` should never print, still counts at both
 * its paths. A count that does not parse is `unknown`; a raw record with no count gets `unknown`,
 * and a count with no raw record gets no modes. Anything out of shape, a last record without its
 * closing NUL included, clears `intact`, so the caller fails closed.
 */
export function parseFloorDiff(output: string): FloorDiff {
	const fields = toFields(output)
	const state: ScanState = { index: 0, intact: true, raw: [], counts: [] }
	while (state.index < fields.length) {
		const field = fields[state.index] ?? ''
		const isRaw = RAW_HEADER.test(field)
		const read =
			isRaw && state.counts.length === 0
				? readRaw(fields, state)
				: !isRaw && readCount(fields, state)
		if (!read) {
			state.intact = false
			break
		}
	}
	const counts = new Map(
		state.counts.map(record => [toPathKey(record.paths), record])
	)
	const files = state.raw.flatMap(record => {
		const key = toPathKey(record.paths)
		const count = counts.get(key)?.count ?? 'unknown'
		counts.delete(key)
		return toFiles(record, count)
	})
	const unmatched = [...counts.values()].flatMap(record =>
		toFiles(
			{ oldMode: '', newMode: '', status: '', paths: record.paths },
			record.count
		)
	)
	return {
		files: [...files, ...unmatched],
		intact:
			state.intact &&
			(output === '' || output.endsWith('\0')) &&
			unmatched.length === 0 &&
			state.raw.length === state.counts.length,
	}
}
