import { HOSTILE_TEXT } from '../../../shared/mocks/hostile-text.helper'
import { bug, LINKS } from '../../../shared/mocks/publish-test.helper'
import { escapeMarkdown } from '../../../utils/markdown.util'
import { parseFindingMarker } from '../domain/publish-marker.parser'
import {
	formatThreadComment,
	toFindingMarker,
	toMarkerComment,
} from './thread-comment.formatter'

describe('formatThreadComment', () => {
	test.each(['title', 'trigger', 'impact', 'suggestion'] as const)(
		'escapes model %s',
		field => {
			const text = formatThreadComment(
				{ finding: bug({ [field]: HOSTILE_TEXT }), kind: 'bug' },
				LINKS,
				true
			)
			const visible = text.split('<!--')[0] ?? ''
			expect(visible).toContain(escapeMarkdown(HOSTILE_TEXT))
			expect(visible).not.toMatch(/(?<!\\)<img/u)
			expect(visible).not.toContain('</details>')
			expect(visible).not.toContain('-->')
			expect(visible).not.toContain('\u202E')
		}
	)
	test('stays far below the comment limit with huge model text', () => {
		const huge = '<>&'.repeat(40_000)
		const text = formatThreadComment(
			{
				finding: bug({
					title: huge,
					trigger: huge,
					impact: huge,
					suggestion: huge,
					evidence: [huge],
				}),
				kind: 'bug',
			},
			LINKS,
			true
		)
		expect(text.length).toBeLessThan(65_536)
		const marker = parseFindingMarker(text)
		expect(marker?.title.length).toBeLessThanOrEqual(301)
		expect(marker?.trigger).toBe(`${huge.slice(0, 3000)}…`)
		expect(marker?.trigger?.length).toBe(3001)
		expect(marker?.impact).toBe(`${huge.slice(0, 3000)}…`)
		expect(marker?.impact?.length).toBe(3001)
	})
	test('escapes unverified premise, evidence, agents and validator model', () => {
		const text = formatThreadComment(
			{
				finding: bug({
					agents: [HOSTILE_TEXT],
					evidence: [`src/store.ts:10 ${HOSTILE_TEXT}`],
					validation: {
						status: 'unverified',
						severity: 'high',
						premise: HOSTILE_TEXT,
						reason: HOSTILE_TEXT,
						model: HOSTILE_TEXT,
						evidence: [],
					},
				}),
				kind: 'unverified',
			},
			LINKS,
			true
		)
		const visible = text.split('<!--')[0] ?? ''
		expect(visible.split(escapeMarkdown(HOSTILE_TEXT))).toHaveLength(5)
		expect(visible).toContain('Not blocking:')
		expect(visible).not.toContain('\u202E')
	})
	test('marker escapes HTML delimiters and ampersands, then decodes back exactly', () => {
		const published = {
			finding: bug({ title: '<!-- close --> & <script>', agents: ['<>&'] }),
			kind: 'bug',
		} as const
		const marker = toFindingMarker(published, LINKS)
		const text = toMarkerComment('finding', marker)
		const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
		expect(json).not.toMatch(/[<>&]/u)
		expect(json).toContain(String.raw`\u003c`)
		expect(json).toContain(String.raw`\u003e`)
		expect(json).toContain(String.raw`\u0026`)
		expect(
			parseFindingMarker(formatThreadComment(published, LINKS, true))
		).toEqual(marker)
	})
	test('links safe evidence to the reviewed head and deduplicates one place', () => {
		const text = formatThreadComment(
			{
				finding: bug({
					evidence: [
						'src/store.ts:10 first',
						'src/store.ts:10 duplicate',
						'src/other.ts:2-4 range',
						'../private.ts:5 unsafe',
						'src/a..b.ts:6 unsafe',
						'src/with space.ts:7 unsafe',
					],
				}),
				kind: 'bug',
			},
			LINKS,
			true
		)
		expect(text.match(/\/blob\/head\/src\/store\.ts#L10/gu)).toHaveLength(1)
		expect(text).toContain(
			'https://github.com/example/project/blob/head/src/other.ts#L2-L4'
		)
		expect(text).not.toContain('duplicate')
		expect(text).not.toContain('/blob/head/../')
		expect(text).not.toContain('/blob/head/src/a..b')
		expect(text).not.toContain('/blob/head/src/with')
	})
	test.each(['bug', 'unverified', 'nit'] as const)(
		'labels %s and shows file fallback with a prose fix',
		kind => {
			const text = formatThreadComment(
				{ finding: bug({ suggestion: 'Use a unique key.' }), kind },
				LINKS,
				false
			)
			expect(text).toContain(
				kind === 'bug'
					? '**High**'
					: kind === 'nit'
						? '**Nit**'
						: '**Unverified, high**'
			)
			expect(text).toContain(`Line ${bug().line} is outside`)
			expect(text).toContain('Fix: Use a unique key.')
			expect(text).not.toContain('```suggestion')
		}
	)
})
