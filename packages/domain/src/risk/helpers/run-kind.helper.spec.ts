import { RISK_RUN_KINDS } from '../risk.constants'
import type { RiskRunKind, RiskRunOutcome, RunEffect } from '../risk.types'
import { getRunEffect } from './run-kind.helper'

/** Rows of the design's run-kind table; repeated rows represent distinct triggers. */
const DESIGN_ROWS = [
	[
		'full rating',
		'full',
		'rated',
		{ status: 'combined', label: 'combined', failsJob: false },
	],
	[
		'incomplete full rating',
		'full',
		'not-rated',
		{ status: 'error', label: 'removed', failsJob: false },
	],
	[
		'writer failed before or in step one',
		'full',
		'step-one-failed',
		{ status: 'none', label: 'removed', failsJob: true },
	],
	[
		'review over cap',
		'over-cap',
		'any',
		{ status: 'none', label: 'kept', failsJob: false, answer: 'cap' },
	],
	[
		'review event bridge',
		'bridge',
		'any',
		{ status: 'none', label: 'kept', failsJob: false, dispatch: 'event' },
	],
	[
		'quick or all-skipped full rating with coverage',
		'full',
		'rated',
		{ status: 'combined', label: 'combined', failsJob: false },
	],
	[
		'thread confirmed High or Critical',
		'thread',
		'raised',
		{ status: 'raised', label: 'raised', failsJob: false },
	],
	[
		'thread read or marker failure',
		'thread',
		'not-rated',
		{ status: 'error', label: 'removed', failsJob: false },
	],
	[
		'sweep missing status and checks pass',
		'sweep',
		'no-status',
		{ status: 'none', label: 'kept', failsJob: false, dispatch: 'review' },
	],
	[
		'sweep missing status and checks fail',
		'sweep',
		'no-status-blocked',
		{ status: 'none', label: 'unlabel', failsJob: false },
	],
	[
		'sweep unnamed reply',
		'sweep',
		'reply-unanswered',
		{ status: 'none', label: 'kept', failsJob: false, dispatch: 'converse' },
	],
	[
		'sweep unrated review',
		'sweep',
		'review-unrated',
		{ status: 'none', label: 'kept', failsJob: false, dispatch: 'review' },
	],
	[
		'denial refused command',
		'denial',
		'refused',
		{ status: 'none', label: 'kept', failsJob: false, answer: 'deny' },
	],
	[
		'denial capped command',
		'denial',
		'over-cap',
		{ status: 'none', label: 'kept', failsJob: false, answer: 'cap' },
	],
	[
		'denial anything else',
		'denial',
		'any',
		{ status: 'none', label: 'kept', failsJob: false },
	],
	[
		'no app environment or offline',
		'unrated',
		'any',
		{ status: 'none', label: 'unlabel', failsJob: false },
	],
	[
		'gate skip, invalid config, fork or other base',
		'unrated',
		'any',
		{ status: 'none', label: 'unlabel', failsJob: false },
	],
	[
		'new push before publish',
		'new-push',
		'any',
		{ status: 'none', label: 'unlabel', failsJob: false },
	],
	[
		'thread writer failed before or in step one',
		'thread',
		'step-one-failed',
		{ status: 'none', label: 'removed', failsJob: true },
	],
] as const satisfies readonly (readonly [
	string,
	RiskRunKind,
	RiskRunOutcome,
	RunEffect,
])[]
const OUTCOMES = [
	'rated',
	'not-rated',
	'step-one-failed',
	'raised',
	'no-status',
	'no-status-blocked',
	'reply-unanswered',
	'review-unrated',
	'refused',
	'over-cap',
	'any',
] as const satisfies readonly RiskRunOutcome[]

describe('risk run kinds', () => {
	test.each(DESIGN_ROWS)('%s', (_name, kind, outcome, expected) => {
		expect(getRunEffect(kind, outcome)).toEqual(expected)
	})
	test.each(RISK_RUN_KINDS)(
		'unlisted %s combinations write nothing; any rows cover every outcome',
		kind => {
			for (const outcome of OUTCOMES) {
				const row =
					DESIGN_ROWS.find(
						([, rowKind, rowOutcome]) =>
							rowKind === kind && rowOutcome === outcome
					) ??
					DESIGN_ROWS.find(
						([, rowKind, rowOutcome]) =>
							rowKind === kind && rowOutcome === 'any' && kind !== 'denial'
					)
				expect(getRunEffect(kind, outcome)).toEqual(
					row?.[3] ?? { status: 'none', label: 'kept', failsJob: false }
				)
			}
		}
	)
})
