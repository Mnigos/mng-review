import {
	type ThreadRecheckProposals,
	toFindingMarker,
} from '@mng-review/github'
import type { PullRequestEvent } from '../../application/shadow-run.types'
import type { OutcomeFile } from '../../infrastructure/outcome-file.schema'
import { BASE_SHA, HEAD_SHA } from './pull-request-event.helper'
import { reviewReport } from './review-report.helper'

export const EVENT = {
	number: 17,
	baseSha: BASE_SHA,
	headSha: HEAD_SHA,
	pr: { labels: [], draft: false, fork: false, trigger: 'auto' },
} as const satisfies PullRequestEvent
export const BINDING_ENV = {
	repository: 'example/project',
	runId: '123',
	runAttempt: '1',
	engineCommit: 'c'.repeat(40),
} as const

/** A complete action report with commits the outcome boundary accepts. */
export function boundReviewReport() {
	const report = reviewReport()
	return {
		...report,
		planReport: {
			...report.planReport,
			change: {
				...report.planReport.change,
				base: { ref: 'main', commit: BASE_SHA },
				head: { ref: 'HEAD', commit: HEAD_SHA },
				mergeBase: BASE_SHA,
			},
		},
	}
}

/** A version-one outcome bound to a public fixture workflow run. */
export function outcomeFile(): OutcomeFile {
	return {
		version: 1,
		binding: {
			...BINDING_ENV,
			pullNumber: EVENT.number,
			baseSha: BASE_SHA,
			headSha: HEAD_SHA,
			trigger: 'push',
		},
		status: 'reviewed',
		report: boundReviewReport(),
	}
}

/** The model's rejected findings still hold their original thread, before file serialization. */
export function recheckProposals(): ThreadRecheckProposals {
	return {
		checked: 2,
		tokens: boundReviewReport().tokens,
		rejected: boundReviewReport().bugs.map((finding, index) => ({
			thread: {
				id: `thread-${index}`,
				resolved: false,
				closedByBot: false,
				onFile: false,
				path: finding.path,
				line: finding.line,
				originalLine: finding.line,
				commit: BASE_SHA,
				replies: 0,
				latestCommentId: undefined,
				latestAuthor: undefined,
				latestMarked: true,
				marker: toFindingMarker(
					{ finding, kind: 'bug' },
					{
						serverUrl: 'https://github.com',
						owner: 'example',
						name: 'project',
						head: BASE_SHA,
						engineCommit: undefined,
					}
				),
			},
			reason: 'The write is guarded.',
		})),
	}
}
