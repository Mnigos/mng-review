import { Command } from 'effect/cli'

/** The root `mng-review` command; review, plan and init arrive as its subcommands. */
export const mngReviewCommand = Command.make('mng-review').pipe(
	Command.withDescription(
		'Pull request review by agents you declare in your repository.'
	)
)
