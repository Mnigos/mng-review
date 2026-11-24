import {
	type ChangedFile,
	type FloorHit,
	getCombinedLevel,
	getHigherLevel,
	getValidatorChoices,
	type KeptFinding,
	type ModelSetting,
	type ReviewConfig,
	type Plan,
	type RiskLevel,
	toCutLine,
	type UnratedReason,
	VALIDATOR_RISK_MODEL,
} from '@mng-review/domain'
import type { ReviewReport } from '../../review/domain/review-report.types'
import {
	MAX_RISK_DIRECTION_CHARS,
	MAX_RISK_REASON_CHARS,
	MAX_RISK_REASONS,
	MAX_RISK_REF_CHARS,
	MAX_RISK_REFS,
} from './rater.constants'
import type { RiskAnswer } from './risk-answer.schema'

/** The run a rating would attach to: the rules' switch, a named agent and the gate's skip. */
export interface RatingRunCheck {
	readonly config: Pick<ReviewConfig, 'risk'>
	readonly onlyAgent?: string
	readonly plan: Pick<Plan, 'skippedRun'>
}

/**
 * True when the run rates: `risk.enabled`, a full run (no single named agent) and a change the
 * gate did not skip. Quick depth and a change whose every file is skipped still rate. A
 * reply-only or converse run never reaches the review, so it never rates.
 */
export function isRatingRun(check: RatingRunCheck): boolean {
	return (
		check.config.risk.enabled &&
		check.onlyAgent === undefined &&
		check.plan.skippedRun === undefined
	)
}

/**
 * Why a reviewed run cannot be rated: a finder failed or only partly ran, or the token budget
 * stopped it.
 */
export interface RatingGap {
	readonly reason: UnratedReason
	readonly detail: string
}

/** What a review reports about how its finders went. */
export type ReviewGapReport = Pick<
	ReviewReport,
	'agents' | 'endpointError' | 'incomplete'
>

/**
 * The gap a review leaves before any rater call; `undefined` when every planned finder finished.
 * A finder that failed for any reason, or whose units only partly ran (an `error` beside `ok`),
 * leaves the run unrated as much as an endpoint failure does.
 */
export function getReviewGap(report: ReviewGapReport): RatingGap | undefined {
	if (report.endpointError)
		return { reason: 'run-failed', detail: report.endpointError }
	if (report.incomplete)
		return { reason: 'budget-stopped', detail: report.incomplete.reason }
	const finder = report.agents.find(
		agent => agent.status !== 'ok' || agent.error !== undefined
	)
	if (!finder) return undefined
	return {
		reason: finder.status === 'incomplete' ? 'budget-stopped' : 'run-failed',
		detail: `finder ${finder.name} ${finder.status === 'ok' ? 'only partly ran' : finder.status}: ${finder.error ?? 'no answer'}`,
	}
}

/**
 * The rater's models in order: `risk.model` first when it names one, then the validator's choice
 * (`models.validator`, else every reviewer model in order).
 */
export function getRaterChoices(config: ReviewConfig): ModelSetting[] {
	const validator = getValidatorChoices({ models: [] }, config)
	const { model } = config.risk
	if (model === VALIDATOR_RISK_MODEL) return validator
	return [model, ...validator.filter(entry => entry.model !== model.model)]
}

/**
 * The answer cut to the rating's limits: blank reasons left out, at most `MAX_RISK_REASONS`
 * reasons and `MAX_RISK_REFS` refs, each on one line and cut with an ellipsis. A long answer is
 * shortened, never refused, so it never costs the rating.
 */
export function toRiskAnswer(answer: RiskAnswer): RiskAnswer {
	const reasons = answer.reasons
		.filter(reason => reason.trim() !== '')
		.slice(0, MAX_RISK_REASONS)
		.map(reason => toCutLine(reason, MAX_RISK_REASON_CHARS))
	const up = answer.up?.trim()
	const down = answer.down?.trim()
	return {
		level: answer.level,
		reasons,
		refs: answer.refs
			.filter(ref => ref.trim() !== '')
			.slice(0, MAX_RISK_REFS)
			.map(ref => toCutLine(ref, MAX_RISK_REF_CHARS)),
		...(up ? { up: toCutLine(up, MAX_RISK_DIRECTION_CHARS) } : {}),
		...(down ? { down: toCutLine(down, MAX_RISK_DIRECTION_CHARS) } : {}),
	}
}

/**
 * Of a first answer and a continuation's, the higher level; on a tie the later, which read more.
 */
export function mergeRiskAnswers(
	first: RiskAnswer,
	next: RiskAnswer
): RiskAnswer {
	return getHigherLevel(first.level, next.level) === next.level ? next : first
}

/** What the engine knows that raises the rater's level, before publish adds its own reads. */
export interface EngineRaises {
	readonly floors: readonly Pick<FloorHit, 'level'>[]
	readonly plan: Pick<Plan, 'router'>
	readonly bugs: readonly KeptFinding[]
}

/**
 * The engine's combined level: the rater's level raised by every floor, Medium for a router
 * `risky` and High for a confirmed High or Critical bug this run kept. Nothing lowers it.
 */
export function getEngineLevel(
	model: RiskLevel,
	raises: EngineRaises
): RiskLevel {
	return getCombinedLevel({
		model,
		floors: raises.floors,
		routerRisky: raises.plan.router.risk === 'risky',
		confirmedBugs: raises.bugs
			.filter(bug => bug.validation?.status === 'confirmed')
			.map(bug => bug.severity),
		markerHighest: 'none',
		held: 'none',
	})
}

/**
 * The changed files the rater must receive whole, by path: every file but binaries, which the
 * floor check already allowed as `risk.assets`, and those whose whole diff its first message holds.
 */
export function getRaterCoverage(
	files: readonly ChangedFile[],
	whole: ReadonlySet<string>
): string[] {
	return files
		.filter(file => !(file.binary || whole.has(file.path)))
		.map(file => file.path)
}
