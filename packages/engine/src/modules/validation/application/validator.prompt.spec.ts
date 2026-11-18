import {
	SEVERITIES,
	SEVERITY_CRITERIA,
	SEVERITY_RUBRIC,
} from '@mng-review/domain'
import { VALIDATOR_PROMPT } from './validator.prompt'

describe('VALIDATOR_PROMPT severity and evidence rules', () => {
	test('uses the complete shared rubric and requires an explanation for lowering', () => {
		expect(VALIDATOR_PROMPT).toContain(SEVERITY_RUBRIC)
		expect(VALIDATOR_PROMPT).toContain('lowered_because')
		expect(VALIDATOR_PROMPT).toContain("the reported level's criterion")
	})
	test.each(SEVERITIES)('includes the shared criterion for %s', severity => {
		expect(VALIDATOR_PROMPT).toContain(SEVERITY_CRITERIA[severity])
	})
	test('requires repository lines for rejection and keeps an unknown dependency premise unverified', () => {
		expect(VALIDATOR_PROMPT).toContain(
			'A rejection without lines from this repository is not accepted.'
		)
		expect(VALIDATOR_PROMPT).toContain(
			'What you remember about a dependency is not evidence'
		)
		expect(VALIDATOR_PROMPT).toContain(
			'the repository neither shows nor rules out'
		)
		expect(VALIDATOR_PROMPT).toContain('answer `unverified`')
	})
})
