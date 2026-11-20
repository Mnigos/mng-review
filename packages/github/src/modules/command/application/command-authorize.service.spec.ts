import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import { GitHubConfig } from '../../../platform/github.config'
import { GitHubApiError } from '../../../platform/github.errors'
import { agent, config } from '../../../shared/mocks/domain-test.helper'
import {
	COMMAND_COMMENT,
	githubApiFake,
} from '../../../shared/mocks/github-api-fake.helper'
import { GITHUB_SETTINGS } from '../../../shared/mocks/github-http.helper'
import {
	APP_IDENTITY,
	APP_MODE_OWNED,
	appSummary,
	SUMMARY_MARKER,
} from '../../../shared/mocks/publish-test.helper'
import { SummaryCommentServiceLive } from '../../publish/application/summary-comment.service'
import type { CommandComment, CommandHandles } from '../domain/command.types'
import {
	CommandAuthorizeService,
	CommandAuthorizeServiceLive,
} from './command-authorize.service'

const COMMENT = {
	eventName: 'issue_comment',
	action: 'created',
	id: COMMAND_COMMENT.id,
	body: COMMAND_COMMENT.body,
	login: COMMAND_COMMENT.user.login,
	type: COMMAND_COMMENT.user.type,
	viaApp: false,
	issueNumber: 17,
	onPullRequest: true,
} as const satisfies CommandComment
const HANDLES = {
	appSlug: 'mng-review',
	handle: '',
} as const satisfies CommandHandles

/** Exercises authorization and summary ownership against the recording in-memory GitHub API. */
function harness() {
	const fake = githubApiFake(APP_IDENTITY)
	const dependencies = Layer.merge(
		fake.api,
		Layer.succeed(GitHubConfig, { ...GITHUB_SETTINGS, identity: APP_IDENTITY })
	)
	const summaries = SummaryCommentServiceLive.pipe(Layer.provide(dependencies))
	const services = CommandAuthorizeServiceLive.pipe(
		Layer.provide(Layer.merge(fake.api, summaries))
	)
	const rules = { config: config(), agents: [agent('storage')] }
	const authorize = (
		comment: CommandComment = COMMENT,
		handles: CommandHandles = HANDLES
	) =>
		CommandAuthorizeService.use(service =>
			service.authorize({ comment, handles, rules })
		).pipe(Effect.provide(services))
	return { fake, rules, authorize }
}

layer(APP_MODE_OWNED)('CommandAuthorizeService', test => {
	for (const [patch, reason] of [
		[
			{ eventName: 'pull_request' },
			'only a new pull request comment starts a review; edits never do',
		],
		[
			{ action: 'edited' },
			'only a new pull request comment starts a review; edits never do',
		],
		[{ onPullRequest: false }, 'the comment is not on a pull request'],
		[{ type: 'Bot' }, 'only a person can start a review'],
		[{ type: 'Organization' }, 'only a person can start a review'],
		[{ viaApp: true }, 'only a person can start a review'],
		[{ login: APP_IDENTITY.restLogin }, 'only a person can start a review'],
		[
			{ login: GITHUB_ACTIONS_IDENTITY.restLogin.toUpperCase() },
			'only a person can start a review',
		],
		[{ body: 'no command' }, 'the comment holds no command'],
	] as const)
		test.effect(`denies before GitHub for ${JSON.stringify(patch)}`, () =>
			Effect.gen(function* () {
				const fixture = harness()
				expect(yield* fixture.authorize({ ...COMMENT, ...patch })).toEqual({
					status: 'denied',
					reason,
				})
				expect(fixture.fake.reads).toEqual([])
				expect(fixture.fake.commentReads).toEqual([])
				expect(fixture.fake.writes).toEqual([])
			})
		)

	for (const handles of [
		{ appSlug: 'mng-review', handle: 'review-helper' },
		{ appSlug: '', handle: '' },
		{ appSlug: 'invalid slug', handle: '' },
	])
		test.effect(
			`denies invalid handle configuration ${JSON.stringify(handles)} before GitHub`,
			() =>
				Effect.gen(function* () {
					const fixture = harness()
					expect(yield* fixture.authorize(COMMENT, handles)).toMatchObject({
						status: 'denied',
					})
					expect(fixture.fake.reads).toEqual([])
					expect(fixture.fake.commentReads).toEqual([])
				})
		)

	test.effect(
		'a changed comment denies before collaborator or pull request reads',
		() =>
			Effect.gen(function* () {
				const fixture = harness()
				fixture.fake.command.comment = {
					...COMMAND_COMMENT,
					body: '@mng-review review deep',
				}
				expect(yield* fixture.authorize()).toEqual({
					status: 'denied',
					reason: 'the comment changed since it was posted',
				})
				expect(fixture.fake.reads).toEqual(['getIssueComment:23'])
				expect(fixture.fake.commentReads).toEqual([])
				expect(fixture.fake.writes).toEqual([])
			})
	)

	for (const role of ['maintain', 'write', 'triage', 'read', 'custom'])
		test.effect(`an unlisted ${role} commenter is denied`, () =>
			Effect.gen(function* () {
				const fixture = harness()
				fixture.fake.command.role = role
				expect(yield* fixture.authorize()).toEqual({
					status: 'denied',
					reason: 'the commenter is not an admin and not in commands.allow',
				})
				expect(fixture.fake.reads).toEqual([
					'getIssueComment:23',
					'getCollaboratorRole:author-a',
				])
				expect(fixture.fake.commentReads).toEqual([])
				expect(fixture.fake.writes).toEqual([])
			})
		)

	for (const role of ['maintain', 'write', 'triage', 'read', 'custom'])
		for (const login of ['author-a', 'AuThOr-A'])
			test.effect(
				`allow list matches ${login} without case and requires a write role for ${role}`,
				() =>
					Effect.gen(function* () {
						const fixture = harness()
						fixture.rules.config = config({ commands: { allow: ['AUTHOR-A'] } })
						fixture.fake.command.role = role
						const decision = yield* fixture.authorize({ ...COMMENT, login })
						if (role === 'maintain' || role === 'write')
							expect(decision).toMatchObject({ status: 'authorized' })
						else
							expect(decision).toEqual({
								status: 'denied',
								reason:
									'the commenter is not an admin and not in commands.allow',
							})
						expect(fixture.fake.reads).toContain(`getCollaboratorRole:${login}`)
						expect(fixture.fake.writes).toEqual([])
					})
			)

	test.effect(
		'an undeclared agent denies before the pull request is read',
		() =>
			Effect.gen(function* () {
				const fixture = harness()
				const body = '@mng-review run unknown'
				fixture.fake.command.comment = { ...COMMAND_COMMENT, body }
				expect(yield* fixture.authorize({ ...COMMENT, body })).toEqual({
					status: 'denied',
					reason: 'no declared agent is named unknown',
				})
				expect(fixture.fake.reads).toEqual([
					'getIssueComment:23',
					'getCollaboratorRole:author-a',
				])
				expect(fixture.fake.commentReads).toEqual([])
			})
	)

	test.effect('a closed pull request denies', () =>
		Effect.gen(function* () {
			const fixture = harness()
			fixture.fake.command.pullRequest = {
				...fixture.fake.command.pullRequest,
				state: 'closed',
			}
			expect(yield* fixture.authorize()).toEqual({
				status: 'denied',
				reason: 'the pull request is not open',
			})
			expect(fixture.fake.commentReads).toEqual([])
			expect(fixture.fake.writes).toEqual([])
		})
	)

	for (const repo of [null, { full_name: 'example/fork' }])
		test.effect(`a fork with head repo ${JSON.stringify(repo)} denies`, () =>
			Effect.gen(function* () {
				const fixture = harness()
				const pr = fixture.fake.command.pullRequest
				fixture.fake.command.pullRequest = { ...pr, head: { ...pr.head, repo } }
				expect(yield* fixture.authorize()).toEqual({
					status: 'denied',
					reason: 'the pull request comes from a fork',
				})
				expect(fixture.fake.commentReads).toEqual([])
				expect(fixture.fake.writes).toEqual([])
			})
		)

	for (const side of ['base', 'head'] as const)
		for (const sha of [
			'',
			'a'.repeat(39),
			'a'.repeat(41),
			'a'.repeat(63),
			'a'.repeat(65),
			'g'.repeat(40),
			'refs/heads/main',
		])
			test.effect(`invalid ${side} SHA ${JSON.stringify(sha)} denies`, () =>
				Effect.gen(function* () {
					const fixture = harness()
					const pr = fixture.fake.command.pullRequest
					fixture.fake.command.pullRequest = {
						...pr,
						[side]: { ...pr[side], sha },
					}
					expect(yield* fixture.authorize()).toEqual({
						status: 'denied',
						reason: 'the pull request has no valid commits',
					})
					expect(fixture.fake.commentReads).toEqual([])
					expect(fixture.fake.writes).toEqual([])
				})
			)

	for (const maxRuns of [1, 3])
		for (const extra of [0, 1])
			test.effect(
				`${maxRuns + extra} manual runs denies at configured limit ${maxRuns}`,
				() =>
					Effect.gen(function* () {
						const fixture = harness()
						fixture.rules.config = config({ commands: { max_runs: maxRuns } })
						fixture.fake.comments.push(
							appSummary({ ...SUMMARY_MARKER, manualRuns: maxRuns + extra })
						)
						expect(yield* fixture.authorize()).toEqual({
							status: 'denied',
							reason: `commands.max_runs reached (${maxRuns})`,
						})
						expect(fixture.fake.commentReads).toEqual([COMMENT.issueNumber])
						expect(fixture.fake.writes).toEqual([])
					})
			)

	for (const operation of [
		'getIssueComment',
		'getCollaboratorRole',
		'getPullRequest',
		'listComments',
	] as const)
		for (const status of [403, 404, 503])
			test.effect(
				`${operation} ${status} returns a denial rather than failing`,
				() =>
					Effect.gen(function* () {
						const fixture = harness()
						const error = new GitHubApiError({
							operation,
							status,
							reason: 'read refused',
						})
						fixture.fake.failures[operation].push(error)
						expect(yield* fixture.authorize()).toEqual({
							status: 'denied',
							reason: `GitHub refused a check: ${error.message}`,
						})
						const order = [
							'getIssueComment:23',
							'getCollaboratorRole:author-a',
							'getPullRequest:17',
						]
						expect(fixture.fake.reads).toEqual(
							operation === 'listComments'
								? order
								: order.slice(
										0,
										order.findIndex(read => read.startsWith(operation)) + 1
									)
						)
						expect(fixture.fake.commentReads).toEqual(
							operation === 'listComments' ? [COMMENT.issueNumber] : []
						)
						expect(fixture.fake.writes).toEqual([])
					})
			)

	for (const [command, expected] of [
		['review', {}],
		['review deep', { depth: 'deep' }],
		['review quick', { depth: 'quick' }],
		['run storage', { agent: 'storage' }],
	] as const)
		for (const handles of [HANDLES, { appSlug: '', handle: 'mng-review' }])
			test.effect(
				`admin authorizes ${command} with ${JSON.stringify(handles)} without an allow-list entry`,
				() =>
					Effect.gen(function* () {
						const fixture = harness()
						const body = `@mng-review ${command}`
						fixture.fake.command.comment = { ...COMMAND_COMMENT, body }
						fixture.fake.comments.push(
							appSummary({
								...SUMMARY_MARKER,
								runs: 100,
								manualRuns: fixture.rules.config.commands.max_runs - 1,
							})
						)
						const pr = fixture.fake.command.pullRequest
						expect(
							yield* fixture.authorize({ ...COMMENT, body }, handles)
						).toEqual({
							status: 'authorized',
							pullNumber: pr.number,
							base: pr.base.sha,
							head: pr.head.sha,
							...expected,
						})
						expect(fixture.fake.writes).toEqual([])
					})
			)

	for (const baseLength of [40, 64])
		for (const headLength of [40, 64])
			test.effect(
				`accepts a ${baseLength}-hex base and ${headLength}-hex head`,
				() =>
					Effect.gen(function* () {
						const fixture = harness()
						const pr = fixture.fake.command.pullRequest
						const base = 'a'.repeat(baseLength)
						const head = 'b'.repeat(headLength)
						fixture.fake.command.pullRequest = {
							...pr,
							base: { ...pr.base, sha: base },
							head: { ...pr.head, sha: head },
						}
						expect(yield* fixture.authorize()).toEqual({
							status: 'authorized',
							pullNumber: pr.number,
							base,
							head,
						})
						expect(fixture.fake.writes).toEqual([])
					})
			)

	test.effect(
		'a legacy summary without manualRuns does not count automatic runs against the command limit',
		() =>
			Effect.gen(function* () {
				const fixture = harness()
				fixture.fake.comments.push(appSummary({ ...SUMMARY_MARKER, runs: 100 }))
				expect(yield* fixture.authorize()).toMatchObject({
					status: 'authorized',
				})
				expect(fixture.fake.writes).toEqual([])
			})
	)

	test.effect('the first command authorizes without a prior summary', () =>
		Effect.gen(function* () {
			const fixture = harness()
			expect(yield* fixture.authorize()).toMatchObject({ status: 'authorized' })
			expect(fixture.fake.commentReads).toEqual([COMMENT.issueNumber])
			expect(fixture.fake.writes).toEqual([])
		})
	)

	test.effect(
		'a previous owned identity summary counts toward the manual run cap',
		() =>
			Effect.gen(function* () {
				const fixture = harness()
				const manualRuns = fixture.rules.config.commands.max_runs
				fixture.fake.comments.push(
					appSummary(
						{ ...SUMMARY_MARKER, manualRuns },
						{
							author: {
								__typename: 'Bot',
								login: GITHUB_ACTIONS_IDENTITY.login,
							},
						}
					)
				)
				expect(yield* fixture.authorize()).toEqual({
					status: 'denied',
					reason: `commands.max_runs reached (${manualRuns})`,
				})
				expect(fixture.fake.commentReads).toEqual([COMMENT.issueNumber])
				expect(fixture.fake.writes).toEqual([])
			})
	)
})
