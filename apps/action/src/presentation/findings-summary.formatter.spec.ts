import { toFinding, type KeptFinding } from '@mng-review/domain'
import {
	reviewReport,
	unverifiedBug,
} from '../shared/mocks/review-report.helper'
import { escapeMarkdown } from '../utils/markdown.util'
import { toFindingsLines } from './findings-summary.formatter'

const MALICIOUS = '![x](https://evil.example/a.png) <img src=x> | col'

/** Distinct titles make ordering independent of duplicate fixture identities. */
function bug(overrides: Partial<KeptFinding> = {}): KeptFinding {
	return {
		...toFinding(
			{
				path: 'src/items.ts',
				line: 2,
				severity: 'high',
				title: 'High confirmed',
				trigger: 'An item is retried.',
				impact: 'An item is lost.',
				evidence: ['src/items.ts:2'],
			},
			{ agent: 'reviewer', model: 'model-a', kind: 'bug' }
		),
		placement: 'inline',
		validation: {
			status: 'confirmed',
			severity: 'high',
			model: 'model-b',
			reason: 'Reproduced.',
			evidence: ['src/items.ts:2'],
		},
		...overrides,
	}
}

describe('toFindingsLines', () => {
	test('orders critical before high and confirmed or unvalidated before unverified, then nits and collapsed rejections', () => {
		const report = reviewReport()
		const text = toFindingsLines({
			...report,
			bugs: [
				unverifiedBug(),
				bug(),
				bug({ severity: 'critical', title: 'Critical confirmed' }),
				bug({
					title: 'High unvalidated',
					validation: {
						status: 'unvalidated',
						error: 'No answer',
						budgetSpent: true,
					},
				}),
			],
		}).join('\n')
		const titles = [
			'Critical confirmed',
			'High confirmed',
			'High unvalidated',
			'Callback receives a full URL',
			'### Nits',
			'<details>',
			'Ownership guard',
			'</details>',
		]
		for (const [index, title] of titles.entries()) {
			expect(text).toContain(title)
			if (index > 0)
				expect(text.indexOf(title)).toBeGreaterThan(
					text.indexOf(titles[index - 1] ?? '')
				)
		}
		expect(text).toContain('#### critical (1)')
		expect(text).toContain('#### high (2)')
		expect(text).toContain('confirmed by model-b')
		expect(text).toContain('not validated, token budget spent')
		expect(text).toContain(
			'rests on: Example Router passes a full URL to the callback.'
		)
		expect(text).toContain('<summary>Rejected by the validator (1)</summary>')
	})
	test('escapes untrusted titles, descriptions, agents, validation premises and rejected reasons', () => {
		const report = reviewReport()
		const malicious = bug({
			title: MALICIOUS,
			trigger: MALICIOUS,
			impact: MALICIOUS,
			evidence: [MALICIOUS],
			agents: [MALICIOUS],
		})
		const text = toFindingsLines({
			...report,
			bugs: [
				malicious,
				{
					...unverifiedBug(),
					validation: {
						...unverifiedBug().validation,
						model: MALICIOUS,
						premise: MALICIOUS,
					},
				},
			],
			nits: [{ ...malicious, kind: 'nit' }],
			rejected: [{ ...malicious, reason: MALICIOUS, validatedBy: MALICIOUS }],
		}).join('\n')
		expect(text).toContain(escapeMarkdown(MALICIOUS))
		expect(text).not.toContain('![')
		expect(text).not.toMatch(/(?<!\\)<img/u)
		expect(text).not.toMatch(/(?<!\\)\| col/u)
		expect(text).toContain(`Trigger: ${escapeMarkdown(MALICIOUS)}`)
		expect(text).toContain(`Impact: ${escapeMarkdown(MALICIOUS)}`)
		expect(text).toContain(
			`rejected by ${escapeMarkdown(MALICIOUS)}, ${escapeMarkdown(MALICIOUS)}`
		)
	})
	test('shows below-floor and no-answer validation labels', () => {
		const text = toFindingsLines(reviewReport()).join('\n')
		expect(text).toContain('reported medium')
		expect(text).toContain(
			'no validator answer, kept, below the severity floor'
		)
	})
	test('empty findings print None and omit optional sections', () => {
		expect(
			toFindingsLines({ ...reviewReport(), bugs: [], nits: [], rejected: [] })
		).toEqual(['', '### Bugs', '', 'None.'])
	})
})
