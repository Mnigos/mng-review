import type { ChangedFile, FileStatus } from './change.types'

/** Status letters of `git diff --name-status`; anything else (unmerged, unknown) counts as modified. */
const STATUS_CODES = {
	A: 'added',
	M: 'modified',
	D: 'deleted',
	R: 'renamed',
	C: 'copied',
	T: 'type_changed',
} as const satisfies Record<string, FileStatus>

/** Line counts of one file from `git diff --numstat`. */
export interface LineCount {
	readonly additions: number
	readonly deletions: number
	readonly binary: boolean
}

/** One entry of `git ls-tree`: `<mode> SP <type> SP <object> [SP <size>] TAB <name>`. */
export interface TreeEntry {
	readonly mode: string
	readonly type: string
	readonly object: string
	/** Present with `ls-tree -l`; `undefined` for trees and gitlinks, which have no size. */
	readonly size: number | undefined
	readonly name: string
}

/** Records of a `-z` output; the trailing NUL gives an empty last field, which is dropped. */
function toFields(output: string): string[] {
	const fields = output.split('\0')
	return fields.at(-1) === '' ? fields.slice(0, -1) : fields
}

/** The status a `--name-status` code stands for, such as `R100` for a rename. */
function toFileStatus(code: string): FileStatus {
	const letter = code.charAt(0)
	return (
		Object.entries(STATUS_CODES).find(([key]) => key === letter)?.[1] ??
		'modified'
	)
}

/** True for a rename or a copy, whose record carries two paths. */
function hasTwoPaths(status: FileStatus): boolean {
	return status === 'renamed' || status === 'copied'
}

/**
 * Parses `git diff --name-status -z -M`. Renames and copies carry the old path then the new one;
 * counts and sizes start at zero for the caller to fill in.
 */
export function parseNameStatus(output: string): ChangedFile[] {
	const fields = toFields(output)
	const files: ChangedFile[] = []
	for (
		let index = 0;
		index < fields.length;
		index += hasTwoPaths(toFileStatus(fields[index] ?? '')) ? 3 : 2
	) {
		const status = toFileStatus(fields[index] ?? '')
		const first = fields[index + 1] ?? ''
		const second = hasTwoPaths(status) ? (fields[index + 2] ?? '') : undefined
		files.push({
			path: second ?? first,
			...(second === undefined ? {} : { oldPath: first }),
			status,
			additions: 0,
			deletions: 0,
			binary: false,
			sizeBytes: 0,
		})
	}
	return files
}

/** A rename's numstat record has an empty path; the old and new paths follow as fields. */
function isRenameCount(entry: string): boolean {
	return entry.split('\t').slice(2).join('\t') === ''
}

/**
 * Parses `git diff --numstat -z -M` into counts by new path. A rename has an empty path field
 * followed by the old and the new path; binary files report `-` for both counts. Tabs inside a
 * path are kept: only the first two tabs separate fields.
 */
export function parseNumstat(output: string): Map<string, LineCount> {
	const fields = toFields(output)
	const counts = new Map<string, LineCount>()
	for (
		let index = 0;
		index < fields.length;
		index += isRenameCount(fields[index] ?? '') ? 3 : 1
	) {
		const [added = '', deleted = '', ...rest] = (fields[index] ?? '').split(
			'\t'
		)
		const path = rest.join('\t')
		const binary = added === '-' && deleted === '-'
		counts.set(path === '' ? (fields[index + 2] ?? '') : path, {
			additions: binary ? 0 : Number(added),
			deletions: binary ? 0 : Number(deleted),
			binary,
		})
	}
	return counts
}

/** Parses `git ls-tree -z [-l]`; each record splits at its first tab, so a name may hold tabs. */
export function parseLsTree(output: string): TreeEntry[] {
	return toFields(output).map(record => {
		const tab = record.indexOf('\t')
		const [mode = '', type = '', object = '', size] = record
			.slice(0, tab)
			.split(' ')
			.filter(Boolean)
		const parsedSize =
			size === undefined || size === '-' ? Number.NaN : Number(size)
		return {
			mode,
			type,
			object,
			size: Number.isInteger(parsedSize) ? parsedSize : undefined,
			name: record.slice(tab + 1),
		}
	})
}

/**
 * The branch name of a full ref from `git rev-parse --symbolic-full-name`: `refs/heads/main` and
 * `refs/remotes/origin/main` both give `main`. Tags, commits and empty output give `undefined`.
 */
export function toBranchName(fullName: string): string | undefined {
	if (fullName.startsWith('refs/heads/'))
		return fullName.slice('refs/heads/'.length) || undefined
	if (!fullName.startsWith('refs/remotes/')) return undefined
	return (
		fullName.slice('refs/remotes/'.length).split('/').slice(1).join('/') ||
		undefined
	)
}
