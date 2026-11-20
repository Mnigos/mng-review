import { ConfigError, formatSchemaIssue } from '@mng-review/domain'
import type { BotThread, BotThreadFile } from '@mng-review/github'
import { Effect, Schema } from 'effect'
import type { PreparedRun } from '../application/shadow-run.types'
import { preparedRunSchema } from './prepared-run.schema'

/** Where the prepare step leaves the prepared file; named in errors instead of the file's path. */
export const PREPARED_PATH_VARIABLE = 'MNG_REVIEW_PREPARED_PATH'

const decodePrepared = Schema.decodeUnknownEffect(
	Schema.fromJsonString(preparedRunSchema)
)

/** A thread from the file, its unknown line, original line and commit `undefined` again. */
function toThread(thread: BotThreadFile): BotThread {
	return {
		...thread,
		line: thread.line,
		originalLine: thread.originalLine,
		commit: thread.commit,
	}
}

/**
 * Parses the prepared file. Invalid JSON, an unknown status or a thread whose marker does not
 * decode fails with a `ConfigError` naming `MNG_REVIEW_PREPARED_PATH`.
 */
export function parsePreparedRun(
	text: string
): Effect.Effect<PreparedRun, ConfigError> {
	return decodePrepared(text).pipe(
		Effect.mapError(
			error =>
				new ConfigError({
					source: PREPARED_PATH_VARIABLE,
					reason: `not a prepared run: ${formatSchemaIssue(error.issue)}`,
				})
		),
		Effect.map((prepared): PreparedRun =>
			prepared.status === 'ready'
				? { ...prepared, threads: prepared.threads.map(toThread) }
				: prepared
		)
	)
}
