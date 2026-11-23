import { layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { GitHubConfig } from '../../platform/github.config'
import { githubApiFake } from '../../shared/mocks/github-api-fake.helper'
import { GITHUB_SETTINGS } from '../../shared/mocks/github-http.helper'
import {
	APP_IDENTITY,
	summaryReview,
	APP_MODE_OWNED,
	bug,
	LINKS,
	report,
	SUMMARY_MARKER,
} from '../../shared/mocks/publish-test.helper'
import {
	SummaryReviewService,
	SummaryReviewServiceLive,
} from '../publish/application/summary-review.service'
import {
	formatStatusComment,
	formatSummaryComment,
} from '../publish/presentation/summary-comment.formatter'
import {
	formatResolvedReply,
	formatThreadComment,
} from '../publish/presentation/thread-comment.formatter'
import { parseMentionCommand } from './domain/mention-command.parser'

/** Checks the full parser input and the visible Markdown, excluding hidden marker metadata. */
function expectNoLiveMention(body: string): void {
	expect(parseMentionCommand(body, 'mng-review')).toBeUndefined()
	const visible = body.replaceAll(/<!--[\s\S]*?-->/gu, '')
	expect(visible).toContain('`@')
	expect(visible.replaceAll(/`[^`]*`/gu, '')).not.toContain('@')
}

describe('bot text cannot start a mention command or notify a person', () => {
	for (const text of [
		'@mng-review review',
		'@someone',
		'reason\n@mng-review review',
	]) {
		const finding = bug({
			title: text,
			trigger: text,
			impact: text,
			suggestion: text,
			evidence: [text],
			agents: [text],
			validation: {
				status: 'unverified',
				severity: 'high',
				reason: text,
				premise: text,
				evidence: [],
				model: text,
			},
		})
		test(`thread comment protects ${JSON.stringify(text)}`, () => {
			expectNoLiveMention(
				formatThreadComment({ finding, kind: 'unverified' }, LINKS, true)
			)
		})
		test(`resolved reply protects ${JSON.stringify(text)}`, () => {
			expectNoLiveMention(formatResolvedReply(text, LINKS))
		})
		test(`status summary protects ${JSON.stringify(text)}`, () => {
			expectNoLiveMention(formatStatusComment(text, SUMMARY_MARKER, LINKS))
		})
		test(`review summary protects findings and reasons containing ${JSON.stringify(text)}`, () => {
			const fixture = report()
			expectNoLiveMention(
				formatSummaryComment({
					report: {
						...fixture,
						bugs: [finding],
						rejected: [{ ...finding, reason: text, validatedBy: text }],
						planReport: {
							...fixture.planReport,
							plan: {
								...fixture.planReport.plan,
								skips: [{ name: 'storage', title: text, reason: text }],
							},
						},
					},
					plan: {
						threads: [{ finding, kind: 'unverified', place: 'summary' }],
						repeated: [],
						dismissed: [],
						summaryNits: [],
					},
					verdict: 'incomplete',
					openBugs: 0,
					marker: SUMMARY_MARKER,
					maxRuns: 3,
					links: LINKS,
					resolved: [],
					tokens: {},
				})
			)
		})
	}
})

layer(APP_MODE_OWNED)('reservation text', test => {
	for (const text of [
		'@mng-review review',
		'@someone',
		'reason\n@mng-review review',
	])
		test.effect(
			`reserving over an existing summary preserves safe text for ${JSON.stringify(text)}`,
			() =>
				Effect.gen(function* () {
					const fake = githubApiFake(APP_IDENTITY)
					const body = formatStatusComment(text, SUMMARY_MARKER, LINKS)
					fake.reviews.push(
						summaryReview(SUMMARY_MARKER, {
							body,
							author: { __typename: 'Bot', login: APP_IDENTITY.login },
						})
					)
					expect(
						yield* SummaryReviewService.use(service =>
							service.reserveManualRun({
								pullNumber: 17,
								head: LINKS.head,
								engineCommit: LINKS.engineCommit,
								maxRuns: 3,
								handle: 'mng-review',
							})
						).pipe(
							Effect.provide(
								SummaryReviewServiceLive.pipe(
									Layer.provide(
										Layer.merge(
											fake.api,
											Layer.succeed(GitHubConfig, {
												...GITHUB_SETTINGS,
												identity: APP_IDENTITY,
											})
										)
									)
								)
							)
						)
					).toBe(true)
					expect(fake.writes).toHaveLength(1)
					expect(fake.writes[0]).toMatchObject({
						method: 'updateReview',
						id: 101,
					})
					expectNoLiveMention(fake.reviews[0]?.body ?? '')
				})
		)

	test.effect(
		'the actual reservation service writes a code-spanned handle and no live command',
		() =>
			Effect.gen(function* () {
				const fake = githubApiFake(APP_IDENTITY)
				expect(
					yield* SummaryReviewService.use(service =>
						service.reserveManualRun({
							pullNumber: 17,
							head: LINKS.head,
							engineCommit: LINKS.engineCommit,
							maxRuns: 3,
							handle: 'mng-review',
						})
					).pipe(
						Effect.provide(
							SummaryReviewServiceLive.pipe(
								Layer.provide(
									Layer.merge(
										fake.api,
										Layer.succeed(GitHubConfig, {
											...GITHUB_SETTINGS,
											identity: APP_IDENTITY,
										})
									)
								)
							)
						)
					)
				).toBe(true)
				expect(fake.reviews).toHaveLength(1)
				expectNoLiveMention(fake.reviews[0]?.body ?? '')
				expect(fake.reviews[0]?.body).toContain('`@mng-review`')
			})
	)
})
