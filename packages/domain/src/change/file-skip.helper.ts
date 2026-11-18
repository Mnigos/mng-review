import { Struct } from 'effect'
import type { ReviewConfig } from '../config/review-config.schema'
import { matchesAnyGlob } from '../utils/glob.util'
import type { ChangedFile, FileSkipReason } from './change.types'

const BYTES_PER_KB = 1024

/** Why the review leaves the file out, in order: `skip.paths`, binary, over `limits.max_file_kb`. */
function getSkipReason(
	file: ChangedFile,
	config: ReviewConfig
): FileSkipReason | undefined {
	if (matchesAnyGlob(file.path, config.skip.paths)) return 'skip.paths'
	if (file.binary) return 'binary'
	if (file.sizeBytes > config.limits.max_file_kb * BYTES_PER_KB)
		return 'too_large'
	return undefined
}

/** Marks the files the review leaves out; an earlier mark is replaced. Inputs are not modified. */
export function applyFileSkips(
	files: readonly ChangedFile[],
	config: ReviewConfig
): ChangedFile[] {
	return files.map(file => {
		const unmarked = Struct.omit(file, ['skipped'])
		const skipped = getSkipReason(file, config)
		return skipped ? { ...unmarked, skipped } : unmarked
	})
}

/** Files the review covers. */
export function getReviewableFiles(
	files: readonly ChangedFile[]
): ChangedFile[] {
	return files.filter(file => !file.skipped)
}
