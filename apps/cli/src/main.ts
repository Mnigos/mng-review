#!/usr/bin/env bun
import { BunRuntime, BunServices } from '@effect/platform-bun'
import { GitWorkdir } from '@mng-review/engine'
import { Effect, Layer } from 'effect'
import { Command } from 'effect/cli'
import { FetchHttpClient } from 'effect/http'
import { version } from '../package.json'
import { CliExit, CONFIG_EXIT_CODE } from './presentation/cli-exit.errors'
import { mngReviewCommand } from './presentation/mng-review.command'

/** Bun's process, file system and terminal, `fetch` for the endpoint, and git in the current directory. */
const PlatformLive = Layer.mergeAll(
	BunServices.layer,
	FetchHttpClient.layer,
	Layer.succeed(GitWorkdir, { cwd: process.cwd() })
)

BunRuntime.runMain(
	mngReviewCommand.pipe(
		Command.run({ version }),
		// The help with the parse errors is already printed; a usage error exits like a configuration error.
		Effect.catchTag('ShowHelp', error =>
			error.errors.length > 0
				? Effect.fail(new CliExit({ code: CONFIG_EXIT_CODE }))
				: Effect.void
		),
		Effect.provide(PlatformLive)
	)
)
