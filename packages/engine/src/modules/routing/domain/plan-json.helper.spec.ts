import { MECHANICAL_CONDITIONS, type ChangeShape } from '@mng-review/domain'
import { reviewRequest } from '../../../shared/mocks/review-test.helper'
import { toPlanJson } from './plan-json.helper'

test('the helper returns an explicit null shape before JSON serialization', () => {
	const report = reviewRequest().planReport
	const json = toPlanJson({
		...report,
		plan: { ...report.plan, shape: undefined },
	})
	expect(json.risk).toHaveProperty('shape', null)
	expect(json.skipped).toBeNull()
})

test.each([true, false])(
	'adds mechanical=%s to a frozen shape without changing the plan input',
	mechanical => {
		const report = reviewRequest().planReport
		const shape = Object.freeze({
			files: 1,
			smallShare: 1,
			netShare: 0,
			riskyRewrites: [],
			failed: mechanical ? [] : MECHANICAL_CONDITIONS,
		} as const satisfies ChangeShape)
		const json = toPlanJson({ ...report, plan: { ...report.plan, shape } })
		expect(json.risk.shape).toEqual({ ...shape, mechanical })
		expect(shape).not.toHaveProperty('mechanical')
		expect(json.risk.shape).not.toBe(shape)
	}
)
