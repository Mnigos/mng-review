import {
	SEVERITIES,
	SEVERITY_CRITERIA,
	SEVERITY_RUBRIC,
} from '@mng-review/domain'
import { FINDING_RULES_PROMPT } from './reviewer.prompt'

describe('FINDING_RULES_PROMPT severity rubric', () => {
	test('uses the complete shared rubric and ties severity to impact', () => {
		expect(FINDING_RULES_PROMPT).toContain(SEVERITY_RUBRIC)
		expect(FINDING_RULES_PROMPT).toContain('`impact` says what goes wrong')
	})
	test.each(SEVERITIES)('includes the shared criterion for %s', severity => {
		expect(FINDING_RULES_PROMPT).toContain(SEVERITY_CRITERIA[severity])
	})
})
