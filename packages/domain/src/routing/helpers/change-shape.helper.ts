import type { ChangedFile } from '../../change/change.types'
import { getReviewableFiles } from '../../change/file-skip.helper'
import {
	MECHANICAL_CONDITIONS,
	MECHANICAL_MAX_NET_SHARE,
	MECHANICAL_MIN_FILES,
	MECHANICAL_MIN_SMALL_SHARE,
	MECHANICAL_REWRITE_MIN_LINES,
	SMALL_EDIT_MAX_LINES,
} from '../routing.constants'
import type { ChangeShape, MechanicalCondition } from '../routing.types'

/** Lines a file adds and removes. */
type LineCounts = Pick<ChangedFile, 'additions' | 'deletions'>

/** Changed lines of a file, added plus removed. */
function getChangedLines(file: LineCounts): number {
	return file.additions + file.deletions
}

/** Share of files that change at most `SMALL_EDIT_MAX_LINES` lines; 0 for no files. */
function getSmallEditShare(files: readonly LineCounts[]): number {
	if (files.length === 0) return 0
	const small = files.filter(
		file => getChangedLines(file) <= SMALL_EDIT_MAX_LINES
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
 * The measured shape of a change against the mechanical conditions, and the conditions it fails:
 * at least `MECHANICAL_MIN_FILES` reviewable files, at least `MECHANICAL_MIN_SMALL_SHARE` of them
 * small edits, added and removed lines within `MECHANICAL_MAX_NET_SHARE` of each other, and no
 * file under `risk_paths` rewritten (`MECHANICAL_REWRITE_MIN_LINES` or more changed lines).
 */
export function getChangeShape(
	files: readonly ChangedFile[],
	riskPathHits: readonly string[]
): ChangeShape {
	const reviewable = getReviewableFiles(files)
	const smallShare = getSmallEditShare(reviewable)
	const netShare = getNetShare(reviewable)
	const riskyRewrites = reviewable
		.filter(
			file =>
				riskPathHits.includes(file.path) &&
				getChangedLines(file) >= MECHANICAL_REWRITE_MIN_LINES
		)
		.map(file => file.path)
	const checks = {
		files: reviewable.length >= MECHANICAL_MIN_FILES,
		small_share: smallShare >= MECHANICAL_MIN_SMALL_SHARE,
		net_share: netShare <= MECHANICAL_MAX_NET_SHARE,
		risky_rewrite: riskyRewrites.length === 0,
	} as const satisfies Record<MechanicalCondition, boolean>
	return {
		files: reviewable.length,
		smallShare,
		netShare,
		riskyRewrites,
		failed: MECHANICAL_CONDITIONS.filter(condition => !checks[condition]),
	}
}

/**
 * A repo-wide mechanical change, such as a lint or format migration: it meets every condition of
 * `getChangeShape`. Such a change does not go deep just because it touches a risky path; a rewrite
 * of a risky file among them does.
 */
export function isMechanicalChange(
	files: readonly ChangedFile[],
	riskPathHits: readonly string[]
): boolean {
	return getChangeShape(files, riskPathHits).failed.length === 0
}
