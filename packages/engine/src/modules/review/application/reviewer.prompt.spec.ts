import {
	MAX_FINDING_TITLE_CHARS,
	MAX_FINDING_IMPACT_CHARS,
	MAX_FINDING_FIX_CHARS,
	MAX_FINDING_STEP_CHARS,
	SEVERITIES,
	SEVERITY_CRITERIA,
	SEVERITY_RUBRIC,
} from '@mng-review/domain'
import { FINDING_RULES_PROMPT, WRITING_RULES_PROMPT } from './reviewer.prompt'

describe('FINDING_RULES_PROMPT severity rubric', () => {
	test('uses the complete shared rubric and ties severity to impact', () => {
		expect(FINDING_RULES_PROMPT).toContain(SEVERITY_RUBRIC)
		expect(FINDING_RULES_PROMPT).toContain('`impact` says what goes wrong')
	})
	test.each(SEVERITIES)('includes the shared criterion for %s', severity => {
		expect(FINDING_RULES_PROMPT).toContain(SEVERITY_CRITERIA[severity])
	})
})

test('finder writing rules include shared wording and all text limits', () => {
	expect(FINDING_RULES_PROMPT).toContain(WRITING_RULES_PROMPT)
	for (const limit of [
		MAX_FINDING_TITLE_CHARS,
		MAX_FINDING_IMPACT_CHARS,
		MAX_FINDING_FIX_CHARS,
		MAX_FINDING_STEP_CHARS,
	])
		expect(FINDING_RULES_PROMPT).toContain(String(limit))
})
