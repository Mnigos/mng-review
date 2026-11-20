import {
	type Change,
	type EvidenceRef,
	getLineCount,
	isEvidenceInCode,
	parseAddedRanges,
	parseEvidenceRef,
	parseLsTree,
	type ReplyClaim,
} from '@mng-review/domain'
import { Context, Effect, Layer } from 'effect'
import { SAFE_DIFF } from '../../../platform/git/git.constants'
import { GitError } from '../../../platform/git/git.errors'
import { GitService } from '../../../platform/git/git.service'
import type { ToolRef } from '../../review/application/repo-tools.types'
import type { RepoScope } from '../../review/application/services/repo-tools.service'
import {
	BINARY_DIFF,
	MAX_EVIDENCE_CHECKED,
	SYMLINK_MODE,
} from '../domain/reply.constants'
import { isRangeRead } from './reply-read.helper'

/**
 * The paths to diff for evidence at `path`: a rename's old path too, so the lines it kept are not
 * counted as added. Only a rename's old path is gone at the head, so the diff holds only the
 * destination's hunks.
 */
function getEvidencePaths(change: Change, path: string): string[] {
	const file = change.files.find(entry => entry.path === path)
	return file?.status === 'renamed' && file.oldPath !== undefined
		? [file.oldPath, path]
		: [path]
}

/** What git shows about one evidence entry. */
interface EvidenceRead {
	/** The entry passes every rule git can check. */
	readonly inCode: boolean
	/** The tree its lines are numbered in: the head, or the merge base for a file missing there. */
	readonly tree: ToolRef
}

/**
 * Checks an `intentional` claim's evidence in git: an entry passes when the classifier was shown
 * every cited line whole and they are code that exists and that the pull request did not add.
 */
export class ReplyEvidenceService extends Context.Service<
	ReplyEvidenceService,
	{
		/** The evidence entries that pass; entries that are not `path:line` never do. */
		readonly check: (
			claim: ReplyClaim,
			scope: RepoScope,
			reads: ReadonlySet<string>
		) => Effect.Effect<readonly string[], GitError>
		/**
		 * The entries that pass every rule but whether the classifier was shown the lines, which only
		 * the review job knows; publishing checks an accepted decision's evidence with it.
		 */
		readonly checkInCode: (
			evidence: readonly string[],
			change: Change
		) => Effect.Effect<readonly string[], GitError>
	}
>()('mng-review/ReplyEvidenceService') {}

export const ReplyEvidenceServiceLive = Layer.effect(
	ReplyEvidenceService,
	Effect.gen(function* () {
		const git = yield* GitService

		/** A commit's tree entry for a path, for its mode. */
		const readEntry = Effect.fn('ReplyEvidenceService.readEntry')(function* (
			commit: string,
			path: string
		) {
			const args = ['ls-tree', '-z', '--full-tree', commit, '--', path]
			const result = yield* git.exec(args)
			if (result.exitCode !== 0)
				return yield* new GitError({
					args,
					exitCode: result.exitCode,
					stderr: result.stderr,
				})
			return parseLsTree(result.stdout).find(entry => entry.name === path)
		})

		/**
		 * Whether the entry is code that exists and that the pull request did not add. A symlink at the
		 * commit the lines are read from (the head, or the merge base when the file is gone at the
		 * head), a file whose text holds a NUL, and a diff git prints as binary (a binary file or one
		 * marked `-diff`, which shows no added lines) never pass.
		 */
		const readEvidence = Effect.fn('ReplyEvidenceService.readEvidence')(
			function* (ref: EvidenceRef, change: Change) {
				const args = [
					'diff',
					'-U0',
					...SAFE_DIFF,
					change.mergeBase,
					change.head.commit,
					'--',
					...getEvidencePaths(change, ref.path),
				]
				const [headEntry, baseEntry, head, base, diff] = yield* Effect.all(
					[
						readEntry(change.head.commit, ref.path),
						readEntry(change.mergeBase, ref.path),
						git.readFileAt(change.head.commit, ref.path),
						git.readFileAt(change.mergeBase, ref.path),
						git.exec(args),
					],
					{ concurrency: 5 }
				)
				if (diff.exitCode !== 0)
					return yield* new GitError({
						args,
						exitCode: diff.exitCode,
						stderr: diff.stderr,
					})
				const tree: ToolRef = head === undefined ? 'base' : 'head'
				const entry = head === undefined ? baseEntry : headEntry
				const excluded =
					entry?.mode === SYMLINK_MODE ||
					BINARY_DIFF.test(diff.stdout) ||
					Boolean((head ?? base)?.includes('\0'))
				const inCode =
					!excluded &&
					isEvidenceInCode(ref, {
						headLines: head === undefined ? undefined : getLineCount(head),
						baseLines: base === undefined ? undefined : getLineCount(base),
						added: parseAddedRanges(diff.stdout),
					})
				return { inCode, tree } satisfies EvidenceRead
			}
		)

		/** The entries, at most `MAX_EVIDENCE_CHECKED`, whose read passes `isPassing`. */
		const filterEvidence = (
			evidence: readonly string[],
			change: Change,
			isPassing: (ref: EvidenceRef, read: EvidenceRead) => boolean
		) =>
			Effect.filter(evidence.slice(0, MAX_EVIDENCE_CHECKED), entry => {
				const ref = parseEvidenceRef(entry)
				if (!ref) return Effect.succeed(false)
				return readEvidence(ref, change).pipe(
					Effect.map(read => isPassing(ref, read))
				)
			})

		const check = Effect.fn('ReplyEvidenceService.check')(function* (
			claim: ReplyClaim,
			scope: RepoScope,
			reads: ReadonlySet<string>
		) {
			return yield* filterEvidence(
				claim.evidence,
				scope.change,
				(ref, read) => read.inCode && isRangeRead(reads, read.tree, ref)
			)
		})

		const checkInCode = Effect.fn('ReplyEvidenceService.checkInCode')(
			function* (evidence: readonly string[], change: Change) {
				return yield* filterEvidence(evidence, change, (_, read) => read.inCode)
			}
		)

		return { check, checkInCode }
	})
)
