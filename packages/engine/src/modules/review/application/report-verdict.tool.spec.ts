import { MAX_VERDICT_REASON_CHARS, MAX_PREMISE_CHARS } from '@mng-review/domain'
import { Result, Schema } from 'effect'
import { Tool } from 'effect/ai'
import { verdict } from '../../../shared/mocks/review-test.helper'
import { ReportVerdictTool } from './report-verdict.tool'

describe('ReportVerdictTool writing contract', () => {
	test('publishes reason, premise and confirmed edit descriptions', () => {
		expect(Tool.getJsonSchema(ReportVerdictTool)).toMatchObject({
			properties: {
				reason: {
					description: expect.stringContaining(
						`at most ${MAX_VERDICT_REASON_CHARS} characters`
					) as unknown,
				},
				premise: {
					description: expect.stringContaining(
						`at most ${MAX_PREMISE_CHARS} characters`
					) as unknown,
				},
				edit: {
					description: expect.stringContaining('For confirm only') as unknown,
					properties: {
						line: {
							description: expect.stringContaining(
								'copied exactly without its line number'
							) as unknown,
						},
						replacement: {
							description: expect.stringContaining(
								'code that replaces that line'
							) as unknown,
						},
					},
				},
			},
		})
	})
	test('accepts optional edits and preserves code whitespace including a deletion', () => {
		const decode = Schema.decodeUnknownResult(
			ReportVerdictTool.parametersSchema
		)
		for (const edit of [
			undefined,
			{ line: '\told() ', replacement: '\tnew()\n' },
			{ line: 'old()', replacement: '' },
		])
			expect(decode(verdict(edit === undefined ? {} : { edit }))).toEqual(
				Result.succeed(verdict(edit === undefined ? {} : { edit }))
			)
	})
})
