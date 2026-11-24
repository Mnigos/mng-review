import {
	MAX_FINDING_TITLE_CHARS,
	MAX_FINDING_IMPACT_CHARS,
	MAX_FINDING_FIX_CHARS,
	MAX_FINDING_STEP_CHARS,
} from '@mng-review/domain'
import { Tool } from 'effect/ai'
import { ReportFindingsTool } from './report-findings.tool'

describe('ReportFindingsTool writing contract', () => {
	test('publishes field descriptions with the shared text limits', () => {
		const schema = Tool.getJsonSchema(ReportFindingsTool)
		expect(schema).toMatchObject({
			properties: {
				findings: {
					items: {
						properties: {
							title: {
								description: expect.stringContaining(
									`at most ${MAX_FINDING_TITLE_CHARS} characters`
								) as unknown,
							},
							impact: {
								description: expect.stringContaining(
									`at most ${MAX_FINDING_IMPACT_CHARS} characters`
								) as unknown,
							},
							suggestion: {
								description: expect.stringContaining(
									`at most ${MAX_FINDING_FIX_CHARS} characters`
								) as unknown,
							},
							trigger: {
								description: expect.stringContaining(
									`at most ${MAX_FINDING_STEP_CHARS} characters`
								) as unknown,
							},
						},
					},
				},
			},
		})
	})
})
