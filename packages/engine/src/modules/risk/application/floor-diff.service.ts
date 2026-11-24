import { type FloorDiff, parseFloorDiff } from '@mng-review/domain'
import { Context, Effect, Layer } from 'effect'
import { GitError } from '../../../platform/git/git.errors'
import { GitService } from '../../../platform/git/git.service'

/** The bound commits a floor diff reads: the merge base and the head. */
export interface FloorRange {
	readonly base: string
	readonly head: string
}

/**
 * `git diff --no-renames --raw --numstat -z`: every path counts on its own, so a rename shows at
 * its old and its new path. No external diff, text conversion or colour runs, whatever the
 * repository's config says.
 */
export function toFloorDiffArgs(range: FloorRange): string[] {
	return [
		'diff',
		'--no-renames',
		'--no-ext-diff',
		'--no-textconv',
		'--no-color',
		'--raw',
		'--numstat',
		'-z',
		'--end-of-options',
		range.base,
		range.head,
	]
}

/**
 * Reads the floor diff of the complete change from git and parses it with the domain parser. A
 * git failure fails the read; output that does not parse whole comes back with `intact` false,
 * which the built-in floor turns into High.
 */
export class FloorDiffService extends Context.Service<
	FloorDiffService,
	{
		readonly read: (range: FloorRange) => Effect.Effect<FloorDiff, GitError>
	}
>()('mng-review/FloorDiffService') {}

export const FloorDiffServiceLive = Layer.effect(
	FloorDiffService,
	Effect.gen(function* () {
		const git = yield* GitService

		const read = Effect.fn('FloorDiffService.read')(function* (
			range: FloorRange
		) {
			const args = toFloorDiffArgs(range)
			const result = yield* git.exec(args)
			if (result.exitCode !== 0)
				return yield* new GitError({
					args,
					exitCode: result.exitCode,
					stderr: result.stderr,
				})
			return parseFloorDiff(result.stdout)
		})

		return { read }
	})
)
