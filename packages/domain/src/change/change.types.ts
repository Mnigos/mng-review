/** How git reports a changed path. */
export type FileStatus =
	| 'added'
	| 'modified'
	| 'deleted'
	| 'renamed'
	| 'copied'
	| 'type_changed'

/** Why a changed file is left out of the review. */
export type FileSkipReason = 'skip.paths' | 'binary' | 'too_large'

/** One changed path between the merge base and the head. */
export interface ChangedFile {
	readonly path: string
	/** Path at the base for renames and copies. */
	readonly oldPath?: string
	readonly status: FileStatus
	readonly additions: number
	readonly deletions: number
	readonly binary: boolean
	/** Size at the head in bytes; 0 for a deleted file. */
	readonly sizeBytes: number
	/** Set when the file is left out of the review. */
	readonly skipped?: FileSkipReason
}

/** A ref as given and the commit it resolved to. */
export interface ResolvedRef {
	readonly ref: string
	readonly commit: string
}

/** What a run reviews: the commits between the merge base and the head. */
export interface Change {
	readonly base: ResolvedRef
	readonly head: ResolvedRef
	readonly mergeBase: string
	readonly files: readonly ChangedFile[]
}
