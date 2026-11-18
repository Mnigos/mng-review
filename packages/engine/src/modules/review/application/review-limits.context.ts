import { Context, type Duration } from 'effect'

/** Limits of one review run: `limits` from `review.yml` and the per-agent bounds. */
export class ReviewLimits extends Context.Service<
	ReviewLimits,
	{
		/** Model calls at once: `limits.concurrency`. */
		readonly concurrency: number
		/** `limits.tokens_per_run`; no call starts once it is spent. */
		readonly tokensPerRun: number
		/** `limits.max_file_kb`; larger files are read only by range. */
		readonly maxFileKb: number
		readonly maxToolCalls: number
		readonly maxWallTime: Duration.Input
	}
>()('mng-review/ReviewLimits') {}
