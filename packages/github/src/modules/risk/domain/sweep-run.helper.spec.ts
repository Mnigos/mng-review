import { type AnswerEntry, toAnswerDigest } from '@mng-review/domain'
import type {
	WorkflowJob,
	WorkflowRun,
} from '../../../platform/github-risk.schema'
import { PUSH_EVENT, RISK_JOB_NAMES } from './risk.constants'
import { toDecideJobName } from './sweep-dispatch.helper'
import { isFullRating, toEntryQualifier, toSweptRun } from './sweep-run.helper'

const TIME = '2026-01-01T12:00:00Z'
const LATER = '2026-01-02T12:00:00Z'
const HEAD = 'b'.repeat(40)
const RUN = {
	id: 7,
	display_title: 'mng-review-risk-17',
	status: 'completed',
	conclusion: 'success',
	created_at: LATER,
	event: 'workflow_dispatch',
	path: '.github/workflows/review.yml',
	head_branch: 'main',
	head_repository: { id: 1 },
} as const satisfies WorkflowRun

/** A completed job with a name and conclusion. */
function job(name: string, conclusion: string | null): WorkflowJob {
	return {
		name,
		status: conclusion === null ? 'in_progress' : 'completed',
		conclusion,
	}
}

/** The decide job of a sweep dispatch of `kind` for comment 42. */
function decide(kind: 'review' | 'converse'): WorkflowJob {
	return job(
		toDecideJobName({
			kind,
			id: 42,
			digest: 'a'.repeat(16),
			at: TIME,
			head: HEAD,
		}),
		'success'
	)
}

describe('sweep runs', () => {
	test('reads the rating job by its fixed name, not the first job after decide', () => {
		const swept = toSweptRun(RUN, [
			decide('review'),
			job('unlabel', 'success'),
			job(RISK_JOB_NAMES.RATING, 'skipped'),
		])
		expect(swept).toMatchObject({ rating: 'skipped', group: 'skipped' })
		expect(isFullRating(swept)).toBe(false)
	})
	test('a converse dispatch takes the converse job as its group job', () => {
		const swept = toSweptRun(RUN, [
			decide('converse'),
			job(RISK_JOB_NAMES.RATING, 'skipped'),
			job(`review / ${RISK_JOB_NAMES.CONVERSE}`, 'cancelled'),
		])
		expect(swept).toMatchObject({ group: 'cancelled', rating: 'skipped' })
	})
	test('a completed run without the fixed job counts as skipped', () => {
		expect(toSweptRun(RUN, [decide('review')])).toMatchObject({
			rating: 'skipped',
			group: 'skipped',
		})
	})
	test('a run in flight has no conclusion yet', () => {
		expect(
			toSweptRun({ ...RUN, status: 'in_progress', conclusion: null }, [
				decide('review'),
				job(RISK_JOB_NAMES.RATING, null),
			])
		).toMatchObject({ rating: null, group: null })
	})
	for (const scenario of [
		{ name: 'push run', run: { event: PUSH_EVENT }, jobs: [], rated: true },
		{
			name: 'review command',
			run: { event: 'issue_comment' },
			jobs: [],
			rated: true,
		},
		{
			name: 'dispatched review',
			run: {},
			jobs: [decide('review')],
			rated: true,
		},
		{
			name: 'dispatched converse',
			run: {},
			jobs: [decide('converse')],
			rated: false,
		},
		{ name: 'dispatch without a key', run: {}, jobs: [], rated: false },
	] as const)
		test(`only push and review runs whose rating job rated count: ${scenario.name}`, () => {
			for (const conclusion of ['success', 'failure', 'cancelled', 'skipped'])
				expect(
					isFullRating(
						toSweptRun({ ...RUN, ...scenario.run }, [
							...scenario.jobs,
							job(RISK_JOB_NAMES.RATING, conclusion),
						])
					)
				).toBe(
					scenario.rated &&
						(conclusion === 'success' || conclusion === 'failure')
				)
		})
	for (const conclusion of ['success', 'failure', 'cancelled', 'skipped', null])
		test(`an earlier answer counts through a later run whose group job ended ${conclusion}`, () => {
			const qualifies = toEntryQualifier([
				toSweptRun(
					{
						...RUN,
						status: conclusion === null ? 'in_progress' : 'completed',
					},
					[decide('converse'), job(RISK_JOB_NAMES.CONVERSE, conclusion)]
				),
			])
			const entry = {
				run: 7,
				kind: 'converse',
				ids: [{ id: 42, at: TIME, digest: toAnswerDigest('confirmed') }],
			} as const satisfies AnswerEntry
			expect(qualifies(entry, { at: TIME })).toBe(conclusion !== 'skipped')
			expect(qualifies(entry, { at: LATER })).toBe(false)
			expect(qualifies({ ...entry, run: 8 }, { at: TIME })).toBe(false)
		})
	for (const conclusion of ['failure', 'success', null])
		test(`reads how the decide job ended: ${conclusion}`, () => {
			expect(
				toSweptRun(
					conclusion === null ? { ...RUN, status: 'in_progress' } : RUN,
					[job(decide('converse').name, conclusion)]
				).decide
			).toBe(conclusion)
		})
	test('a run without a decide job has no decide conclusion', () => {
		expect(
			toSweptRun(RUN, [job(RISK_JOB_NAMES.RATING, 'success')]).decide
		).toBeUndefined()
	})
})
