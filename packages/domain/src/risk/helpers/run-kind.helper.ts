import type { RiskRunKind, RiskRunOutcome, RunEffect } from '../risk.types'

/** Every case the table does not list writes nothing. */
const WRITES_NOTHING = {
	status: 'none',
	label: 'kept',
	failsJob: false,
} as const satisfies RunEffect
const COMBINED = {
	status: 'combined',
	label: 'combined',
	failsJob: false,
} as const satisfies RunEffect
const NOT_RATED = {
	status: 'error',
	label: 'removed',
	failsJob: false,
} as const satisfies RunEffect
const STEP_ONE_FAILED = {
	status: 'none',
	label: 'removed',
	failsJob: true,
} as const satisfies RunEffect
const UNLABELED = {
	status: 'none',
	label: 'unlabel',
	failsJob: false,
} as const satisfies RunEffect

/** The run-kind table of the risk design, one entry per row. */
const RUN_TABLE = {
	full: {
		rated: COMBINED,
		'not-rated': NOT_RATED,
		'step-one-failed': STEP_ONE_FAILED,
	},
	thread: {
		raised: { status: 'raised', label: 'raised', failsJob: false },
		'not-rated': NOT_RATED,
		'step-one-failed': STEP_ONE_FAILED,
	},
	'over-cap': { any: { ...WRITES_NOTHING, answer: 'cap' } },
	bridge: { any: { ...WRITES_NOTHING, dispatch: 'event' } },
	sweep: {
		'no-status': { ...WRITES_NOTHING, dispatch: 'review' },
		'no-status-blocked': UNLABELED,
		'reply-unanswered': { ...WRITES_NOTHING, dispatch: 'converse' },
		'review-unrated': { ...WRITES_NOTHING, dispatch: 'review' },
	},
	denial: {
		refused: { ...WRITES_NOTHING, answer: 'deny' },
		'over-cap': { ...WRITES_NOTHING, answer: 'cap' },
	},
	unrated: { any: UNLABELED },
	'new-push': { any: UNLABELED },
} as const satisfies Record<
	RiskRunKind,
	Partial<Record<RiskRunOutcome, RunEffect>>
>

/**
 * What a run of `kind` that ended in `outcome` does to the head, from the run-kind table. A kind's
 * `any` row covers every outcome; anything the table does not list writes nothing.
 */
export function getRunEffect(
	kind: RiskRunKind,
	outcome: RiskRunOutcome
): RunEffect {
	const rows: Partial<Record<RiskRunOutcome, RunEffect>> = RUN_TABLE[kind]
	return rows[outcome] ?? rows.any ?? WRITES_NOTHING
}
