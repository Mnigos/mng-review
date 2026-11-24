import {
	getReviewableFiles,
	parseFileDiffs,
	type PlannedRun,
	splitReviewUnits,
} from '@mng-review/domain'
import { fenceData } from '../../../utils/fence.util'
import {
	getFirstDiffChars,
	getReadingTokens,
	getUnitCount,
	getCoverageScale,
	getUnitsToReview,
} from '../domain/finder-budget.helper'
import {
	getWholePaths,
	toChangeMessage,
	toContextNotes,
	toUnitMessage,
} from '../domain/finder-message.helper'
import { toEstimatedTokens } from '../domain/loop-budget.helper'
import { toOutputPage } from '../domain/output-part.helper'
import {
	CONTEXT_READ_TOKENS,
	MAX_FULL_DIFF_CHARS,
	MAX_INCREMENTAL_DIFF_CHARS,
	MIN_READING_TURNS,
	READ_CALLS_PER_TURN,
	TOOL_OUTPUT_LABEL,
} from '../domain/review.constants'
import type { FinderContext, FinderJob } from './finder.types'
import { getChangedLines } from './read-coverage.helper'
import { ALL_REPO_TOOLS } from './repo.toolkit'
import {
	FINDING_RULES_PROMPT,
	REVIEWER_PROMPT,
	UNIT_PROMPT,
} from './reviewer.prompt'

const FILE_HEADER = /^(?=diff --git )/mu

/** What the main reviewer's conversations are built from. */
export interface ReviewerJobsInput {
	readonly run: PlannedRun
	readonly context: FinderContext
	/** The diff the reviewer reviews: every reviewable file, or a narrowed reviewer's focus files. */
	readonly diff: string
	/** A later reviewer model at deep depth that reviews only the focus files. */
	readonly narrowed: boolean
}

/** The pages `diff(path)` returns for one file's section, each as the model receives it. */
function toDiffPages(section: string): string[] {
	const pages: string[] = []
	for (let offset = 0; offset < section.length;) {
		const page = toOutputPage(section, offset)
		pages.push(fenceData(TOOL_OUTPUT_LABEL, page.output))
		offset = page.end
	}
	return pages
}

/**
 * Tokens a conversation with this first message needs to read every page of the diff of each
 * `coverage` file, and `CONTEXT_READ_TOKENS` around them, then answer (`getReadingTokens`): at
 * least `MIN_READING_TURNS` turns, as many as its longest file has pages, and enough for every
 * page at `READ_CALLS_PER_TURN` a turn.
 */
export function getReadingNeed(
	job: Pick<FinderJob, 'system' | 'user'>,
	diff: string,
	coverage: readonly string[]
): number {
	const pages = diff
		.split(FILE_HEADER)
		.filter(section => {
			const path = parseFileDiffs(section)[0]?.path
			return path !== undefined && coverage.includes(path)
		})
		.map(toDiffPages)
	const read = pages
		.flat()
		.reduce((sum, page) => sum + toEstimatedTokens(page), CONTEXT_READ_TOKENS)
	const turns = Math.max(
		MIN_READING_TURNS,
		Math.ceil(pages.flat().length / READ_CALLS_PER_TURN),
		...pages.map(page => page.length)
	)
	return getReadingTokens(toEstimatedTokens(job.system + job.user), read, turns)
}

/**
 * A main reviewer job with the tokens reading its cut files needs, sized from `diff`, the
 * reviewer's whole diff, since `diff(path)` returns each file whole; none when it has none.
 */
function withNeed(job: FinderJob, diff: string): FinderJob {
	const coverage = job.coverage ?? []
	if (coverage.length === 0) return job
	return { ...job, need: getReadingNeed(job, diff, coverage) }
}

/**
 * The main reviewer's conversations: one per unit of a deep review (`getUnitCount`: as many as
 * the reviewer's share pays for, more for a large diff), each with an even part of that share, or
 * one over the whole change. Each must
 * read the files its first message does not show whole (`coverage`) and carries the tokens that
 * needs (`need`); an empty list when a narrowed reviewer's focus touches no unit.
 */
export function toReviewerJobs(input: ReviewerJobsInput): FinderJob[] {
	const { context, diff, run } = input
	const { pr } = context.scope
	const system = [
		REVIEWER_PROMPT,
		...toContextNotes(context.rules.context),
		FINDING_RULES_PROMPT,
	].join('\n\n')
	const { allowance } = context.tokens
	const split = context.fanOut
		? splitReviewUnits(diff, getUnitCount(allowance, diff.length))
		: []
	const units = getUnitsToReview(split, context.unitPaths)
	if ((split.length > 0 || input.narrowed) && units.length === 0) return []
	if (split.length > 1 || input.narrowed) {
		const tokens = Math.floor(allowance / Math.max(1, units.length))
		return units.map(unit => {
			const maxChars = getFirstDiffChars(tokens, MAX_INCREMENTAL_DIFF_CHARS)
			const whole = getWholePaths(unit.diff, maxChars)
			const job = {
				unit: unit.label,
				system: `${system}\n\n${UNIT_PROMPT}`,
				user: toUnitMessage({
					unit,
					files: context.scope.change.files,
					pr,
					maxChars,
				}),
				tools: ALL_REPO_TOOLS,
				tokens,
				coverage: unit.paths.filter(path => !whole.has(path)),
				changed: getChangedLines(unit.diff),
			}
			// `diff(path)` returns a file's whole diff, not the unit's hunks of it.
			return withNeed(job, diff)
		})
	}
	const maxChars = getFirstDiffChars(allowance, MAX_FULL_DIFF_CHARS)
	const whole = getWholePaths(diff, maxChars)
	const job = {
		system,
		user: toChangeMessage({
			files: context.scope.change.files,
			scope: run.files,
			pr,
			diff,
			maxChars,
		}),
		tools: ALL_REPO_TOOLS,
		tokens: allowance,
		coverage: getReviewableFiles(context.scope.change.files)
			.map(file => file.path)
			.filter(path => run.files.includes(path) && !whole.has(path)),
		changed: getChangedLines(diff),
	}
	return [withNeed(job, diff)]
}

/** Each planned run's jobs with the tokens reading their cut files needs, and what that took. */
export interface SizedJobs {
	/** By planned run; `undefined` where its jobs could not be built. */
	readonly jobs: readonly (readonly FinderJob[] | undefined)[]
	/** Tokens granted beyond the jobs' shares. */
	readonly granted: number
	/** Tokens beyond the shares that reading every cut file needs. */
	readonly needed: number
	/** `room` was too small, so every grant was cut by the same factor (`getCoverageScale`). */
	readonly capped: boolean
}

/** Tokens a job lacks of its `need`. */
function getExtraTokens(job: FinderJob): number {
	return Math.max(0, (job.need ?? job.tokens) - job.tokens)
}

/**
 * The planned runs' jobs with each job's `tokens` raised to its `need`, the tokens reading every
 * file it must read takes, within `room` tokens for all of them together.
 */
export function toSizedJobs(
	runs: readonly (readonly FinderJob[] | undefined)[],
	room: number
): SizedJobs {
	const all = runs.flatMap(jobs => jobs ?? [])
	const needed = all.reduce((sum, job) => sum + getExtraTokens(job), 0)
	const scale = getCoverageScale(needed, room)
	const grant = (job: FinderJob) => Math.floor(getExtraTokens(job) * scale)
	return {
		jobs: runs.map(jobs =>
			jobs?.map(job => ({ ...job, tokens: job.tokens + grant(job) }))
		),
		granted: all.reduce((sum, job) => sum + grant(job), 0),
		needed,
		capped: scale < 1,
	}
}
