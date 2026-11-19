import { layer } from '@effect/vitest'
import {
	PublishService,
	GitHubApiError,
	StatusReportService,
} from '@mng-review/github'
import { Effect, Layer } from 'effect'
import { reviewReport, RULES } from '../shared/mocks/review-report.helper'
import { PublishRunService, PublishRunServiceLive } from './publish-run.service'
import type { ShadowOutcome, PullRequestEvent } from './shadow-run.types'

const EVENT = {
	number: 17,
	baseSha: 'base',
	headSha: 'head',
	pr: { labels: [], draft: false, fork: false, trigger: 'auto' },
} as const satisfies PullRequestEvent
const CONTEXT = { engineCommit: 'engine' } as const
const PUBLISHED = {
	verdict: 'needs fixes',
	openBugs: 1,
	onLine: 1,
	onFile: 0,
	inSummary: 0,
	unposted: 0,
	repeated: 0,
	dismissed: 0,
	rechecked: 0,
	resolved: 0,
	run: 1,
} as const

/** Publisher test layer records which outcome path is taken and can fail either write. */
function setup(fail = false) {
	const publishSpy = vi.fn(() =>
		fail
			? Effect.fail(
					new GitHubApiError({
						operation: 'publish',
						reason: 'offline',
						status: 503,
					})
				)
			: Effect.succeed(PUBLISHED)
	)
	const publishStatusSpy = vi.fn(() =>
		fail
			? Effect.fail(
					new GitHubApiError({ operation: 'status', reason: 'offline' })
				)
			: Effect.succeed(true)
	)
	const reportSpy = vi.fn(() => Effect.succeed({ checks: 1, status: true }))
	const reportOfflineSpy = vi.fn(() => Effect.succeed(true))
	const service = PublishRunServiceLive.pipe(
		Layer.provide(
			Layer.merge(
				Layer.succeed(StatusReportService, {
					report: reportSpy,
					reportOffline: reportOfflineSpy,
				}),
				Layer.succeed(PublishService, {
					readPrior: () => Effect.succeed(undefined),
					publish: publishSpy,
					publishStatus: publishStatusSpy,
				})
			)
		)
	)
	return { service, publishSpy, publishStatusSpy, reportSpy, reportOfflineSpy }
}

layer(Layer.empty)('PublishRunService', test => {
	test.effect('passes report, base rules and target to publishing', () =>
		Effect.gen(function* () {
			const fixture = setup()
			const service = yield* PublishRunService.pipe(
				Effect.provide(fixture.service)
			)
			const report = reviewReport()
			expect(
				yield* service.run(
					{ status: 'reviewed', event: EVENT, report, rules: RULES },
					CONTEXT
				)
			).toEqual({
				status: 'published',
				result: PUBLISHED,
				checks: { checks: 1, status: true },
			})
			expect(fixture.publishSpy).toHaveBeenCalledExactlyOnceWith({
				pullNumber: EVENT.number,
				pr: EVENT.pr,
				report,
				rules: RULES,
				head: EVENT.headSha,
				engineCommit: CONTEXT.engineCommit,
			})
			expect(fixture.publishStatusSpy).not.toHaveBeenCalled()
			expect(fixture.reportSpy).toHaveBeenCalledExactlyOnceWith({
				head: EVENT.headSha,
				report,
				verdict: PUBLISHED.verdict,
				openBugs: PUBLISHED.openBugs,
			})
			expect(fixture.reportOfflineSpy).not.toHaveBeenCalled()
		})
	)
	test.effect(
		'offline publishes its summary and reports an offline status',
		() =>
			Effect.gen(function* () {
				const fixture = setup()
				const service = yield* PublishRunService.pipe(
					Effect.provide(fixture.service)
				)
				expect(
					yield* service.run(
						{ status: 'offline', event: EVENT, reason: 'no endpoint' },
						CONTEXT
					)
				).toEqual({
					status: 'status-only',
					reason: 'Reviewer offline: no endpoint. Nothing was reviewed.',
					posted: true,
				})
				expect(fixture.publishSpy).not.toHaveBeenCalled()
				expect(fixture.reportOfflineSpy).toHaveBeenCalledExactlyOnceWith(
					EVENT.headSha
				)
				expect(fixture.reportSpy).not.toHaveBeenCalled()
				expect(fixture.publishStatusSpy).toHaveBeenCalledExactlyOnceWith({
					pullNumber: EVENT.number,
					head: EVENT.headSha,
					engineCommit: CONTEXT.engineCommit,
					status: 'Reviewer offline: no endpoint. Nothing was reviewed.',
				})
			})
	)
	for (const status of ['reviewed', 'offline'] as const)
		test.effect(
			`${status} GitHub failure becomes a failed report without failing the effect`,
			() =>
				Effect.gen(function* () {
					const fixture = setup(true)
					const service = yield* PublishRunService.pipe(
						Effect.provide(fixture.service)
					)
					const outcome: ShadowOutcome =
						status === 'reviewed'
							? { status, report: reviewReport(), rules: RULES, event: EVENT }
							: { status, reason: 'offline', event: EVENT }
					const published = yield* service.run(outcome, CONTEXT)
					expect(published.status).toBe('failed')
					if (published.status === 'failed')
						expect(published.reason).toContain('offline')
				})
		)
	for (const outcome of [
		{ status: 'skipped', reason: 'skip' },
		{ status: 'invalid-config', source: '.mng/review.yml', reason: 'invalid' },
		{ status: 'failed', event: EVENT, reason: 'git failure' },
	] as const satisfies readonly ShadowOutcome[])
		test.effect(`${outcome.status} writes nothing`, () =>
			Effect.gen(function* () {
				const fixture = setup()
				const service = yield* PublishRunService.pipe(
					Effect.provide(fixture.service)
				)
				expect(yield* service.run(outcome, CONTEXT)).toMatchObject({
					status: 'not-published',
				})
				expect(fixture.publishSpy).not.toHaveBeenCalled()
				expect(fixture.publishStatusSpy).not.toHaveBeenCalled()
			})
		)
	for (const skippedRun of [undefined, 'skip rule'])
		test.effect(
			`empty review plan publishes unless gated by ${skippedRun}`,
			() =>
				Effect.gen(function* () {
					const fixture = setup()
					const service = yield* PublishRunService.pipe(
						Effect.provide(fixture.service)
					)
					const report = reviewReport()
					const reviewed = {
						...report,
						planReport: {
							...report.planReport,
							plan: {
								...report.planReport.plan,
								runs: [],
								...(skippedRun ? { skippedRun } : {}),
							},
						},
					}

					expect(
						yield* service.run(
							{
								status: 'reviewed',
								event: EVENT,
								rules: RULES,
								report: reviewed,
							},
							CONTEXT
						)
					).toMatchObject({
						status: skippedRun ? 'not-published' : 'published',
						...(skippedRun
							? { reason: skippedRun }
							: { result: PUBLISHED, checks: { checks: 1, status: true } }),
					})
					if (skippedRun) {
						expect(fixture.publishSpy).not.toHaveBeenCalled()
						expect(fixture.reportSpy).not.toHaveBeenCalled()
					} else {
						expect(fixture.publishSpy).toHaveBeenCalledOnce()
						expect(fixture.reportSpy).toHaveBeenCalledExactlyOnceWith({
							head: EVENT.headSha,
							report: reviewed,
							verdict: PUBLISHED.verdict,
							openBugs: PUBLISHED.openBugs,
						})
					}
				})
		)
})
