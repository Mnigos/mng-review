import { escapeMarkdown, REVIEW_EVENTS } from '@mng-review/github'
import type { PublishReport } from '../application/publish-run.service'
import { formatPublishLogLine, formatPublishSummary } from './summary.formatter'

for (const status of ['published', 'replied'] as const)
	for (const event of REVIEW_EVENTS)
		test(`${status} includes review ${event} in the job summary and log`, () => {
			const standing = {
				verdict: event === 'REQUEST_CHANGES' ? 'needs fixes' : 'ready',
				event,
				dismissal: { dismissed: 1, failed: 2 },
				openBugs: event === 'REQUEST_CHANGES' ? 1 : 0,
				answered: {},
				waiting: 0,
				label: 'none',
				run: 3,
				unsettled: 0,
			} as const
			const report =
				status === 'replied'
					? { status, result: { ...standing, status: true } }
					: ({
							status,
							checks: { checks: 0, status: true },
							result: {
								...standing,
								onLine: 0,
								onFile: 0,
								inSummary: 0,
								unposted: 0,
								repeated: 0,
								dismissed: 0,
								rechecked: 0,
								resolved: 0,
								finished: true,
								cleanup: 'none',
							},
						} as const satisfies PublishReport)
			expect(formatPublishLogLine(report)).toContain(`review ${event}`)
			expect(formatPublishLogLine(report)).toContain(
				'1 stale review(s) dismissed, 2 not dismissed'
			)
			expect(formatPublishSummary(report, 'engine')).toContain(
				escapeMarkdown('1 stale review(s) dismissed, 2 not dismissed')
			)
			expect(formatPublishSummary(report, 'engine')).toContain(
				escapeMarkdown(`review ${event}`)
			)
		})

for (const status of ['published', 'replied'] as const)
	test(`${status} says when a push right after the write dismissed the run's own review`, () => {
		const standing = {
			verdict: 'ready',
			event: 'APPROVE',
			outlived: true,
			dismissal: { dismissed: 1, failed: 0 },
			openBugs: 0,
			answered: {},
			waiting: 0,
			label: 'none',
			run: 3,
			unsettled: 0,
		} as const
		const report =
			status === 'replied'
				? { status, result: { ...standing, status: true } }
				: ({
						status,
						checks: { checks: 0, status: true },
						result: {
							...standing,
							onLine: 0,
							onFile: 0,
							inSummary: 0,
							unposted: 0,
							repeated: 0,
							dismissed: 0,
							rechecked: 0,
							resolved: 0,
							finished: true,
							cleanup: 'none',
						},
					} as const satisfies PublishReport)
		expect(formatPublishLogLine(report)).toContain(
			'review APPROVE (dismissed: a push landed right after it),'
		)
	})
