import { escapeMarkdown, REVIEW_EVENTS } from '@mng-review/github'
import type { PublishReport } from '../application/publish-run.service'
import { formatPublishLogLine, formatPublishSummary } from './summary.formatter'

for (const status of ['published', 'replied'] as const)
	for (const event of REVIEW_EVENTS)
		test(`${status} includes review ${event} in the job summary and log`, () => {
			const standing = {
				verdict: event === 'REQUEST_CHANGES' ? 'needs fixes' : 'ready',
				event,
				openBugs: event === 'REQUEST_CHANGES' ? 1 : 0,
				answered: {},
				waiting: 0,
				label: 'none',
				run: 3,
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
			expect(formatPublishSummary(report, 'engine')).toContain(
				escapeMarkdown(`review ${event}`)
			)
		})
