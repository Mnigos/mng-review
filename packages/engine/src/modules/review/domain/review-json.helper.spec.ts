import { reviewRequest } from '../../../shared/mocks/review-test.helper'
import { toPlanJson } from '../../routing/domain/plan-json.helper'
import { toReviewJson } from './review-json.helper'
import { toEmptyReviewReport } from './review-report.helper'

test('absent endpoint error and incomplete run are explicit nulls before serialization', () => {
	const json = toReviewJson(toEmptyReviewReport(reviewRequest().planReport, 12))
	expect(json).toHaveProperty('endpointError', null)
	expect(json).toHaveProperty('incomplete', null)
})

test('keeps both an endpoint error and an incomplete run when present', () => {
	const report = {
		...toEmptyReviewReport(reviewRequest().planReport, 12),
		endpointError: 'endpoint unavailable',
		incomplete: { reason: 'budget spent', unfinished: ['reviewer'] },
	}
	const json = toReviewJson(report)
	expect(json.endpointError).toBe(report.endpointError)
	expect(json.incomplete).toEqual(report.incomplete)
})

test('flattens the plan and never exposes the internal planReport property', () => {
	const report = toEmptyReviewReport(reviewRequest().planReport, 12)
	const json = toReviewJson(report)
	expect(json).not.toHaveProperty('planReport')
	expect(json).not.toHaveProperty('plan')
	expect(json).not.toHaveProperty('change')
	expect(json).toMatchObject(toPlanJson(report.planReport))
	expect(report).toHaveProperty('planReport', report.planReport)
})
