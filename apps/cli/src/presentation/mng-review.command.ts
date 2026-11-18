import { Command } from 'effect/cli'
import { planCommand } from './plan.command'
import { reviewCommand } from './review.command'

/** The root `mng-review` command: a review with `--base`, or a subcommand such as `plan`. */
export const mngReviewCommand = reviewCommand.pipe(
	Command.withDescription(
		'Pull request review by agents you declare in your repository. Exits 0 with no bug at or above the severity floor, 1 with one, 2 on a configuration or endpoint error.'
	),
	Command.withSubcommands([planCommand])
)
