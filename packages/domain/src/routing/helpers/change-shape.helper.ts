import type { ChangedFile } from '../../change/change.types'
import { getReviewableFiles } from '../../change/file-skip.helper'
import {
	MECHANICAL_MAX_NET_SHARE,
	MECHANICAL_MIN_FILES,
	MECHANICAL_MIN_SMALL_SHARE,
	SMALL_EDIT_MAX_LINES,
} from '../routing.constants'

/** Lines a file adds and removes. */
type LineCounts = Pick<ChangedFile, 'additions' | 'deletions'>

/** Share of files that change at most `SMALL_EDIT_MAX_LINES` lines; 0 for no files. */
function getSmallEditShare(files: readonly LineCounts[]): number {
	if (files.length === 0) return 0
	const small = files.filter(
		file => file.additions + file.deletions <= SMALL_EDIT_MAX_LINES
	)
	return small.length / files.length
}

/** How far added and removed lines differ, as a share of both: 0 rewrites in place, 1 only adds. */
function getNetShare(files: readonly LineCounts[]): number {
	const added = files.reduce((sum, file) => sum + file.additions, 0)
	const removed = files.reduce((sum, file) => sum + file.deletions, 0)
	return Math.abs(added - removed) / Math.max(1, added + removed)
}

/**
 * A repo-wide mechanical change, such as a lint or format migration: at least
 * `MECHANICAL_MIN_FILES` reviewable files, most of them small edits, about as many lines removed as
 * added, and every file under `risk_paths` a small edit too, so one real rewrite of a risky file
 * keeps the change risky. Such a change does not go deep just
 * because it touches a risky path; a real edit to a risky file among them does.
 */
export function isMechanicalChange(
	files: readonly ChangedFile[],
	riskPathHits: readonly string[]
): boolean {
	const reviewable = getReviewableFiles(files)
	if (reviewable.length < MECHANICAL_MIN_FILES) return false
	const risky = reviewable.filter(file => riskPathHits.includes(file.path))
	return (
		getSmallEditShare(reviewable) >= MECHANICAL_MIN_SMALL_SHARE &&
		getNetShare(reviewable) <= MECHANICAL_MAX_NET_SHARE &&
		risky.every(file => file.additions + file.deletions <= SMALL_EDIT_MAX_LINES)
	)
}
