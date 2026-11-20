import { layer } from '@effect/vitest'
import { ConfigProvider, Effect, Layer, Redacted } from 'effect'
import { GITHUB_CREDENTIAL } from '../shared/mocks/github-http.helper'
import {
	APP_SLUG_VARIABLE,
	APP_TOKEN_VARIABLE,
	MINTED_APP_SLUG_VARIABLE,
	GitHubReadConfigLive,
	GITHUB_TOKEN_VARIABLE,
	GitHubConfig,
	GitHubWriteConfigLive,
} from './github.config'

const ENVIRONMENT = {
	GITHUB_TOKEN: GITHUB_CREDENTIAL,
	GITHUB_REPOSITORY: 'example-owner/example-repo',
} as const satisfies Record<string, string>

/** Loads only the supplied environment, without consulting the process environment. */
function loadConfig(environment: Record<string, string>) {
	return GitHubConfig.pipe(
		Effect.provide(GitHubWriteConfigLive),
		Effect.provide(
			ConfigProvider.layer(ConfigProvider.fromEnvRecord(environment))
		)
	)
}

layer(Layer.empty)('GitHubConfig', test => {
	for (const token of [undefined, '', ' \t '])
		test.effect(`rejects missing or empty token ${String(token)}`, () =>
			Effect.gen(function* () {
				const failure = yield* loadConfig({
					GITHUB_REPOSITORY: ENVIRONMENT.GITHUB_REPOSITORY,
					...(token === undefined ? {} : { GITHUB_TOKEN: token }),
				}).pipe(Effect.flip)
				expect(failure).toMatchObject({
					_tag: 'ConfigError',
					source: GITHUB_TOKEN_VARIABLE,
				})
				expect(failure.message).toContain(GITHUB_TOKEN_VARIABLE)
			})
		)
	for (const repository of [
		undefined,
		'',
		' ',
		'owner',
		'/repo',
		'owner/',
		'owner/repo/extra',
		'owner with spaces/repo',
		'https://github.com/owner/repo',
	])
		test.effect(
			`rejects missing or malformed repository ${String(repository)}`,
			() =>
				Effect.gen(function* () {
					const failure = yield* loadConfig({
						GITHUB_TOKEN: GITHUB_CREDENTIAL,
						...(repository === undefined
							? {}
							: { GITHUB_REPOSITORY: repository }),
					}).pipe(Effect.flip)
					expect(failure).toMatchObject({
						_tag: 'ConfigError',
						source: 'GITHUB_REPOSITORY',
					})
					expect(failure.message).toContain('GITHUB_REPOSITORY')
					expect(failure.message).not.toContain(GITHUB_CREDENTIAL)
				})
		)
	test.effect('defaults URLs and keeps the required token redacted', () =>
		Effect.gen(function* () {
			const config = yield* loadConfig(ENVIRONMENT)
			expect(config).toMatchObject({
				owner: 'example-owner',
				name: 'example-repo',
				serverUrl: 'https://github.com',
				apiUrl: 'https://api.github.com',
				graphqlUrl: 'https://api.github.com/graphql',
			})
			expect(Redacted.isRedacted(config.token)).toBeTruthy()
			expect(Redacted.value(config.token)).toBe(GITHUB_CREDENTIAL)
			expect(String(config.token)).not.toContain(GITHUB_CREDENTIAL)
			expect(JSON.stringify(config)).not.toContain(GITHUB_CREDENTIAL)
		})
	)
	test.effect(
		'trims repository and normalizes all configured URL trailing slashes',
		() =>
			Effect.gen(function* () {
				expect(
					yield* loadConfig({
						...ENVIRONMENT,
						GITHUB_REPOSITORY: ' example-owner/example.repo-1 ',
						GITHUB_SERVER_URL: ' https://github.example.test/// ',
						GITHUB_API_URL: ' https://github.example.test/api/v3/// ',
						GITHUB_GRAPHQL_URL: ' https://github.example.test/api/graphql/// ',
					})
				).toMatchObject({
					owner: 'example-owner',
					name: 'example.repo-1',
					serverUrl: 'https://github.example.test',
					apiUrl: 'https://github.example.test/api/v3',
					graphqlUrl: 'https://github.example.test/api/graphql',
				})
			})
	)
})

layer(Layer.empty)('GitHub identity configuration', test => {
	for (const [mode, slug, jobToken, appToken, minted, expectedToken, login] of [
		['write', '', 'job-fixture', '', '', 'job-fixture', 'github-actions'],
		[
			'write',
			'mng-review',
			'',
			'app-fixture',
			'mng-review',
			'app-fixture',
			'mng-review',
		],
		[
			'write',
			'MNG-REVIEW',
			'',
			'app-fixture',
			'MnG-ReViEw',
			'app-fixture',
			'mng-review',
		],
		['read', '', 'job-fixture', '', '', 'job-fixture', 'github-actions'],
		['read', 'mng-review', 'job-fixture', '', '', 'job-fixture', 'mng-review'],
	] as const)
		test.effect(
			`${mode} slug=${slug} minted=${minted} selects the required redacted token`,
			() =>
				Effect.gen(function* () {
					const config = yield* GitHubConfig.pipe(
						Effect.provide(
							mode === 'write' ? GitHubWriteConfigLive : GitHubReadConfigLive
						),
						Effect.provide(
							ConfigProvider.layer(
								ConfigProvider.fromEnvRecord({
									...ENVIRONMENT,
									GITHUB_TOKEN: jobToken,
									MNG_REVIEW_APP_SLUG: slug,
									MNG_REVIEW_APP_TOKEN: appToken,
									MNG_REVIEW_MINTED_APP_SLUG: minted,
								})
							)
						)
					)
					expect(config.identity).toEqual({ login, restLogin: `${login}[bot]` })
					expect(Redacted.value(config.token)).toBe(expectedToken)
					expect(JSON.stringify(config)).not.toContain(expectedToken)
				})
		)
	for (const [mode, slug, jobToken, appToken, minted, source] of [
		['write', '', 'job-fixture', 'app-fixture', '', APP_TOKEN_VARIABLE],
		['write', '', 'job-fixture', '', 'mng-review', MINTED_APP_SLUG_VARIABLE],
		['write', 'mng-review', '', '', 'mng-review', APP_TOKEN_VARIABLE],
		['write', 'mng-review', '', 'app-fixture', '', MINTED_APP_SLUG_VARIABLE],
		[
			'write',
			'mng-review',
			'',
			'app-fixture',
			'other-app',
			MINTED_APP_SLUG_VARIABLE,
		],
		[
			'write',
			'mng-review',
			'job-fixture',
			'app-fixture',
			'mng-review',
			GITHUB_TOKEN_VARIABLE,
		],
		['write', 'Mng Review', '', 'app-fixture', 'Mng Review', APP_SLUG_VARIABLE],
		[
			'write',
			'mng-review[bot]',
			'',
			'app-fixture',
			'mng-review[bot]',
			APP_SLUG_VARIABLE,
		],
		['read', 'Mng Review', 'job-fixture', '', '', APP_SLUG_VARIABLE],
		['read', 'mng-review[bot]', 'job-fixture', '', '', APP_SLUG_VARIABLE],
		[
			'read',
			'mng-review',
			'',
			'app-fixture',
			'mng-review',
			GITHUB_TOKEN_VARIABLE,
		],
	] as const)
		test.effect(
			`${mode} rejects slug=${slug} job=${jobToken !== ''} app=${appToken !== ''} minted=${minted}`,
			() =>
				Effect.gen(function* () {
					const failure = yield* GitHubConfig.pipe(
						Effect.provide(
							mode === 'write' ? GitHubWriteConfigLive : GitHubReadConfigLive
						),
						Effect.provide(
							ConfigProvider.layer(
								ConfigProvider.fromEnvRecord({
									...ENVIRONMENT,
									GITHUB_TOKEN: jobToken,
									MNG_REVIEW_APP_SLUG: slug,
									MNG_REVIEW_APP_TOKEN: appToken,
									MNG_REVIEW_MINTED_APP_SLUG: minted,
								})
							)
						),
						Effect.flip
					)
					expect(failure).toMatchObject({ _tag: 'ConfigError', source })
					expect(failure.message).toContain(source)
					expect(failure.message).not.toContain('app-fixture')
					expect(failure.message).not.toContain('job-fixture')
				})
		)
})
