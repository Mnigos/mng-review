import { SEVERITIES } from '@mng-review/domain'
import { HOSTILE_TEXT } from '../../../shared/mocks/hostile-text.helper'
import { bug } from '../../../shared/mocks/publish-test.helper'
import { escapeMarkdown } from '../../../utils/markdown.util'
import {
	SEVERITY_MARKERS,
	UNVERIFIED_MARKER,
} from '../../publish/domain/publish.constants'
import { formatCheckSummary } from './check-run.formatter'

describe('formatCheckSummary finding markers', () => {
	test.each(SEVERITIES)(
		'uses the shared %s marker for bugs and omits it for nits',
		severity => {
			const title = HOSTILE_TEXT
			const name = `${severity.charAt(0).toUpperCase()}${severity.slice(1)}`
			expect(formatCheckSummary([bug({ severity, title })])).toContain(
				`- ${SEVERITY_MARKERS[severity]} **${name}** \`src/store.ts:10\` ${escapeMarkdown(title)}`
			)
			const nit = formatCheckSummary([bug({ severity, title, kind: 'nit' })])
			expect(nit).toContain('- **Nit** ')
			for (const marker of [
				...Object.values(SEVERITY_MARKERS),
				UNVERIFIED_MARKER,
			])
				expect(nit).not.toContain(marker)
		}
	)
	test('uses the unverified marker with the rerated severity', () => {
		expect(
			formatCheckSummary([
				bug({
					severity: 'medium',
					validation: {
						status: 'unverified',
						severity: 'medium',
						reason: 'Unknown.',
						premise: 'A package retries.',
						evidence: [],
						model: 'model',
					},
				}),
			])
		).toContain(`${UNVERIFIED_MARKER} **Unverified, medium**`)
	})
})
