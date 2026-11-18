#!/usr/bin/env bun
import { BunRuntime, BunServices } from '@effect/platform-bun'
import { Effect } from 'effect'
import { Command } from 'effect/cli'
import { version } from '../package.json'
import { mngReviewCommand } from './presentation/mng-review.command'

BunRuntime.runMain(
	mngReviewCommand.pipe(
		Command.run({ version }),
		Effect.provide(BunServices.layer)
	)
)
