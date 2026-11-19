import { ConfigError } from '@mng-review/domain'
import { Config, Context, Effect, Layer, Option, Redacted } from 'effect'

export const GITHUB_TOKEN_VARIABLE = 'GITHUB_TOKEN'
const DEFAULT_SERVER_URL = 'https://github.com'
const DEFAULT_API_URL = 'https://api.github.com'
const DEFAULT_GRAPHQL_URL = 'https://api.github.com/graphql'
/** `owner/name`, each part as GitHub allows it. */
const REPOSITORY_PATTERN = /^([\w.-]+)\/([\w.-]+)$/u

/** Where the GitHub API is, which repository the run belongs to and the job's token. */
export class GitHubConfig extends Context.Service<
	GitHubConfig,
	{
		/** Where pages of the repository are, for links in comments. */
		readonly serverUrl: string
		readonly apiUrl: string
		readonly graphqlUrl: string
		readonly owner: string
		readonly name: string
		/** The job's `GITHUB_TOKEN`; unwrapped only where requests are built. */
		readonly token: Redacted.Redacted
	}
>()('mng-review/GitHubConfig') {}

/**
 * `GITHUB_TOKEN` and `GITHUB_REPOSITORY` are required; `GITHUB_SERVER_URL`, `GITHUB_API_URL` and
 * `GITHUB_GRAPHQL_URL` default to github.com. An empty token counts as unset. A missing or malformed value fails with a `ConfigError` naming the variable.
 */
export const GitHubConfigLive = Layer.effect(
	GitHubConfig,
	Effect.gen(function* () {
		const settings = yield* Config.all({
			token: Config.option(Config.Redacted(GITHUB_TOKEN_VARIABLE)),
			repository: Config.option(Config.String('GITHUB_REPOSITORY')),
			serverUrl: Config.String('GITHUB_SERVER_URL').pipe(
				Config.withDefault(DEFAULT_SERVER_URL)
			),
			apiUrl: Config.String('GITHUB_API_URL').pipe(
				Config.withDefault(DEFAULT_API_URL)
			),
			graphqlUrl: Config.String('GITHUB_GRAPHQL_URL').pipe(
				Config.withDefault(DEFAULT_GRAPHQL_URL)
			),
		}).pipe(
			Effect.mapError(
				() =>
					new ConfigError({
						source: 'GITHUB_TOKEN, GITHUB_REPOSITORY or GITHUB_API_URL',
						reason: 'could not be read',
					})
			)
		)
		if (
			Option.isNone(settings.token) ||
			Redacted.value(settings.token.value).trim() === ''
		)
			return yield* new ConfigError({
				source: GITHUB_TOKEN_VARIABLE,
				reason: 'is not set; publish mode needs the job token',
			})
		const match = REPOSITORY_PATTERN.exec(
			Option.getOrElse(settings.repository, () => '').trim()
		)
		if (!match?.[1] || !match[2])
			return yield* new ConfigError({
				source: 'GITHUB_REPOSITORY',
				reason: 'is not set or not owner/name',
			})
		return {
			serverUrl: settings.serverUrl.trim().replace(/\/+$/u, ''),
			apiUrl: settings.apiUrl.trim().replace(/\/+$/u, ''),
			graphqlUrl: settings.graphqlUrl.trim(),
			owner: match[1],
			name: match[2],
			token: settings.token.value,
		}
	})
)
