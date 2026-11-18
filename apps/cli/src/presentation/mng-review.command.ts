import { Command } from 'effect/cli'
import { planCommand } from './plan.command'

/** The root `mng-review` command; review and init arrive as further subcommands. */
export const mngReviewCommand = Command.make('mng-review').pipe(
	Command.withDescription(
		'Pull request review by agents you declare in your repository.'
	),
	Command.withSubcommands([planCommand])
)
