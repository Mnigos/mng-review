import { BOT_SLUG_PATTERN, ConfigError } from '@mng-review/domain'
import { Config, Context, Effect, Layer, Option, Redacted } from 'effect'
import {
	type BotIdentity,
	GITHUB_ACTIONS_IDENTITY,
	toBotIdentity,
} from './bot-identity.helper'

export const GITHUB_TOKEN_VARIABLE = 'GITHUB_TOKEN'
export const APP_SLUG_VARIABLE = 'MNG_REVIEW_APP_SLUG'
export const APP_TOKEN_VARIABLE = 'MNG_REVIEW_APP_TOKEN'
export const MINTED_APP_SLUG_VARIABLE = 'MNG_REVIEW_MINTED_APP_SLUG'
const DEFAULT_SERVER_URL = 'https://github.com'
const DEFAULT_API_URL = 'https://api.github.com'
const DEFAULT_GRAPHQL_URL = 'https://api.github.com/graphql'
/** `owner/name`, each part as GitHub allows it. */
const REPOSITORY_PATTERN = /^([\w.-]+)\/([\w.-]+)$/u

/** Where the GitHub API is, which repository the run belongs to, the token and whose it is. */
export class GitHubConfig extends Context.Service<
	GitHubConfig,
	{
		/** Where pages of the repository are, for links in comments. */
		readonly serverUrl: string
		readonly apiUrl: string
		readonly graphqlUrl: string
		readonly owner: string
		readonly name: string
		/** The job token or the app token; unwrapped only where requests are built. */
		readonly token: Redacted.Redacted
		/** The bot the token posts as: the app in app mode, `github-actions` otherwise. */
		readonly identity: BotIdentity
	}
>()('mng-review/GitHubConfig') {}

/** A token and the identity it posts as, picked by the mode's rules. */
interface TokenChoice {
	readonly token: Redacted.Redacted
	readonly identity: BotIdentity
}

/** The variables both modes read; an empty value counts as unset. */
const settingsConfig = Config.all({
	jobToken: Config.option(Config.Redacted(GITHUB_TOKEN_VARIABLE)),
	appToken: Config.option(Config.Redacted(APP_TOKEN_VARIABLE)),
	appSlug: Config.String(APP_SLUG_VARIABLE).pipe(Config.withDefault('')),
	mintedSlug: Config.String(MINTED_APP_SLUG_VARIABLE).pipe(
		Config.withDefault('')
	),
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
})
type Settings = Config.Success<typeof settingsConfig>

/** A set, non-blank token, or `undefined`. */
function getToken(
	value: Option.Option<Redacted.Redacted>
): Redacted.Redacted | undefined {
	if (Option.isNone(value) || Redacted.value(value.value).trim() === '')
		return undefined
	return value.value
}

/** The app's identity from `MNG_REVIEW_APP_SLUG`; a slug GitHub would not give fails. */
const getAppIdentity = Effect.fn('GitHubConfig.getAppIdentity')(function* (
	slug: string
) {
	if (!BOT_SLUG_PATTERN.test(slug))
		return yield* new ConfigError({
			source: APP_SLUG_VARIABLE,
			reason: 'is not a GitHub App slug',
		})
	return toBotIdentity(slug)
})

/** The job token with the identity the slug names, for the steps that only read GitHub. */
const toReadToken = Effect.fn('GitHubConfig.toReadToken')(function* (
	settings: Settings
) {
	const token = getToken(settings.jobToken)
	if (!token)
		return yield* new ConfigError({
			source: GITHUB_TOKEN_VARIABLE,
			reason: 'is not set; reading the pull request needs the job token',
		})
	const slug = settings.appSlug.trim()
	const identity =
		slug === '' ? GITHUB_ACTIONS_IDENTITY : yield* getAppIdentity(slug)
	return { token, identity } satisfies TokenChoice
})

/**
 * The token a writing step posts with: the job token without a slug, the app token with one. Each
 * mode forbids the other mode's variables, so the step never holds a token it does not post with.
 */
const toWriteToken = Effect.fn('GitHubConfig.toWriteToken')(function* (
	settings: Settings
) {
	const jobToken = getToken(settings.jobToken)
	const appToken = getToken(settings.appToken)
	const slug = settings.appSlug.trim()
	const minted = settings.mintedSlug.trim()
	if (slug === '') {
		if (appToken || minted !== '')
			return yield* new ConfigError({
				source: appToken ? APP_TOKEN_VARIABLE : MINTED_APP_SLUG_VARIABLE,
				reason: `is set without ${APP_SLUG_VARIABLE}`,
			})
		if (!jobToken)
			return yield* new ConfigError({
				source: GITHUB_TOKEN_VARIABLE,
				reason: `is not set; without ${APP_SLUG_VARIABLE} the bot posts with the job token`,
			})
		return {
			token: jobToken,
			identity: GITHUB_ACTIONS_IDENTITY,
		} satisfies TokenChoice
	}
	const identity = yield* getAppIdentity(slug)
	if (!appToken)
		return yield* new ConfigError({
			source: APP_TOKEN_VARIABLE,
			reason: `is not set; ${APP_SLUG_VARIABLE} posts with the app token`,
		})
	if (minted.toLowerCase() !== identity.login)
		return yield* new ConfigError({
			source: MINTED_APP_SLUG_VARIABLE,
			reason: `does not match ${APP_SLUG_VARIABLE}; the token belongs to another app`,
		})
	if (jobToken)
		return yield* new ConfigError({
			source: GITHUB_TOKEN_VARIABLE,
			reason: `must be empty when ${APP_SLUG_VARIABLE} is set`,
		})
	return { token: appToken, identity } satisfies TokenChoice
})

/**
 * Reads the shared variables and builds the config with the token `choose` picks.
 * `GITHUB_REPOSITORY` is required; `GITHUB_SERVER_URL`, `GITHUB_API_URL` and `GITHUB_GRAPHQL_URL`
 * default to github.com. A missing or malformed value fails with a `ConfigError` naming it.
 */
const makeGitHubConfig = (
	choose: (settings: Settings) => Effect.Effect<TokenChoice, ConfigError>
) =>
	Effect.gen(function* () {
		const settings = yield* settingsConfig.pipe(
			Effect.mapError(
				() =>
					new ConfigError({
						source: 'the GitHub variables',
						reason: 'could not be read',
					})
			)
		)
		const { token, identity } = yield* choose(settings)
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
			graphqlUrl: settings.graphqlUrl.trim().replace(/\/+$/u, ''),
			owner: match[1],
			name: match[2],
			token,
			identity,
		}
	})

/**
 * For the steps that write (publish, sweep, raise). Without `MNG_REVIEW_APP_SLUG`: `GITHUB_TOKEN` is
 * required and the app variables must be empty. With it: a valid slug, `MNG_REVIEW_APP_TOKEN`,
 * `MNG_REVIEW_MINTED_APP_SLUG` equal to the slug without regard to case, and an empty
 * `GITHUB_TOKEN`.
 */
export const GitHubWriteConfigLive = Layer.effect(
	GitHubConfig,
	makeGitHubConfig(toWriteToken)
)

/**
 * For the steps that only read (prepare): `GITHUB_TOKEN` is required, and `MNG_REVIEW_APP_SLUG`,
 * when set, names whose comments the token reads as the bot's.
 */
export const GitHubReadConfigLive = Layer.effect(
	GitHubConfig,
	makeGitHubConfig(toReadToken)
)
