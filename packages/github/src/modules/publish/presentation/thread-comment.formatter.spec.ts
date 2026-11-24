import { SEVERITIES } from '@mng-review/domain'
import {
	HOSTILE_TEXT,
	toTextOutsideCode,
} from '../../../shared/mocks/hostile-text.helper'
import {
	bug,
	botThread,
	LINKS,
} from '../../../shared/mocks/publish-test.helper'
import { escapeMarkdown } from '../../../utils/markdown.util'
import {
	parseFindingMarker,
	parseReplyMarker,
} from '../domain/publish-marker.parser'
import { isSameProblem } from '../domain/publish-plan.helper'
import {
	formatThreadComment,
	formatResolvedReply,
	MAX_COMMENT_CHARS,
	toKindLabel,
	toKindTag,
	toFindingMarker,
	toMarkerComment,
} from './thread-comment.formatter'

import {
	MARKER_VERSION,
	SEVERITY_MARKERS,
	UNVERIFIED_MARKER,
	SHORT_SHA_LENGTH,
} from '../domain/publish.constants'
import { toFindingBodyLines } from './finding-body.formatter'

describe('formatThreadComment', () => {
	test.each(['title', 'trigger', 'impact', 'suggestion'] as const)(
		'escapes model %s',
		field => {
			const text = formatThreadComment(
				{ finding: bug({ [field]: HOSTILE_TEXT }), kind: 'bug' },
				LINKS,
				true
			)
			const visible = toTextOutsideCode(text.split('<!--')[0] ?? '')
			expect(visible).toContain(escapeMarkdown(HOSTILE_TEXT))
			expect(visible).not.toMatch(/(?<!\\)<img/u)
			expect(
				visible
					.split('\n')
					.filter(line => line.includes('</details>') && line !== '</details>')
			).toEqual([])
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
		expect(text.length).toBeLessThan(MAX_COMMENT_CHARS)
		const marker = parseFindingMarker(text)
		expect(marker?.title.length).toBeLessThanOrEqual(301)
		expect(marker?.trigger).toBe(`${huge.slice(0, 3000)}…`)
		expect(marker?.trigger?.length).toBe(3001)
		expect(marker?.impact).toBe(`${huge.slice(0, 3000)}…`)
		expect(marker?.impact?.length).toBe(3001)
	})
	test('replaces oversized details with a note while preserving the heading and marker', () => {
		const long = '*'.repeat(3000)
		const published = {
			finding: bug({
				trigger: long,
				impact: long,
				suggestion: long,
				evidence: Array.from({ length: 6 }, (_, index) => `${index}${long}`),
				agents: Array.from({ length: 50 }, () => '*'.repeat(200)),
			}),
			kind: 'bug',
		} as const
		const marker = toFindingMarker(published, LINKS)
		const markerComment = toMarkerComment('finding', marker)
		const heading = `${SEVERITY_MARKERS.high} **High** · ${published.finding.title}`
		expect(
			[
				heading,
				'',
				...toFindingBodyLines(published.finding, LINKS, 'line'),
				'',
				markerComment,
			].join('\n').length
		).toBeGreaterThan(MAX_COMMENT_CHARS)
		const body = formatThreadComment(published, LINKS, true)
		expect(body.length).toBeLessThan(MAX_COMMENT_CHARS)
		expect(body).toBe(
			[
				heading,
				'',
				'The details are too long for one comment; the job summary has the run.',
				'',
				markerComment,
			].join('\n')
		)
		expect(parseFindingMarker(body)).toEqual(marker)
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
		const visible = toTextOutsideCode(text.split('<!--')[0] ?? '')
		expect(visible.split(escapeMarkdown(HOSTILE_TEXT))).toHaveLength(5)
		expect(visible).toContain('<summary>Why it does not block</summary>')
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
			expect(text).toContain('**Fix:** Use a unique key.')
			expect(text).not.toContain('```suggestion')
		}
	)
})

describe('formatResolvedReply', () => {
	test('cuts a 20,000-character reason and preserves the closing marker', () => {
		const reason = '*'.repeat(20_000)
		const body = formatResolvedReply(reason, LINKS)
		expect(body.length).toBeLessThan(10_000)
		expect(body).toContain(`${escapeMarkdown(reason.slice(0, 3000))}…`)
		expect(body).toContain('The bot no longer counts this thread as open.')
		expect(parseReplyMarker(body)).toEqual({
			v: MARKER_VERSION,
			action: 'resolved',
			commit: LINKS.head,
		})
	})
	test('escapes the reason, names the short head and closes the bot count with a reply marker', () => {
		const links = { ...LINKS, head: 'abcdef1234567890' }
		const body = formatResolvedReply(HOSTILE_TEXT, links)
		expect(body).toBe(
			[
				`No longer found at \`${links.head.slice(0, SHORT_SHA_LENGTH)}\`: ${escapeMarkdown(HOSTILE_TEXT)} The bot no longer counts this thread as open.`,
				'',
				toMarkerComment('reply', {
					v: MARKER_VERSION,
					action: 'resolved',
					commit: links.head,
				}),
			].join('\n')
		)
		expect(parseReplyMarker(body)).toEqual({
			v: MARKER_VERSION,
			action: 'resolved',
			commit: links.head,
		})
	})
})

describe('thread heading and matching compatibility', () => {
	test.each(SEVERITIES)(
		'uses the shared severity marker for %s in labels, tags and thread headings',
		severity => {
			const name = `${severity.charAt(0).toUpperCase()}${severity.slice(1)}`
			expect(toKindLabel('bug', severity)).toBe(
				`${SEVERITY_MARKERS[severity]} ${name}`
			)
			expect(toKindTag('bug', severity)).toBe(
				`${SEVERITY_MARKERS[severity]} **${name}**`
			)
			expect(
				formatThreadComment(
					{ finding: bug({ severity, title: HOSTILE_TEXT }), kind: 'bug' },
					LINKS,
					true
				).split('\n')[0]
			).toBe(
				`${SEVERITY_MARKERS[severity]} **${name}** · ${escapeMarkdown(HOSTILE_TEXT)}`
			)
			expect(toKindLabel('unverified', severity)).toBe(
				`${UNVERIFIED_MARKER} Unverified, ${severity}`
			)
			expect(toKindTag('unverified', severity)).toBe(
				`${UNVERIFIED_MARKER} **Unverified, ${severity}**`
			)
			expect(toKindLabel('nit', severity)).toBe('Nit')
			expect(toKindTag('nit', severity)).toBe('**Nit**')
		}
	)
	test.each([true, false])(
		'keeps a parseable marker last and matches the same problem with onLine=%s',
		onLine => {
			const finding = bug({
				title: HOSTILE_TEXT,
				trigger: HOSTILE_TEXT,
				impact: HOSTILE_TEXT,
			})
			const published = { finding, kind: 'bug' } as const
			const text = formatThreadComment(published, LINKS, onLine)
			const marker = parseFindingMarker(text)
			expect(marker).toEqual(toFindingMarker(published, LINKS))
			expect(
				text.endsWith(
					toMarkerComment('finding', toFindingMarker(published, LINKS))
				)
			).toBe(true)
			if (!marker) return
			expect(
				isSameProblem(finding, botThread({ marker, onFile: !onLine }))
			).toBe(true)
		}
	)
	test('offers a suggestion only for an on-line thread', () => {
		const finding = bug({
			validation: {
				status: 'confirmed',
				severity: 'high',
				reason: 'Confirmed.',
				evidence: [],
				model: 'model',
				edit: {
					commit: LINKS.head,
					line: bug().line,
					original: 'old()',
					replacement: 'new()',
				},
			},
		})
		expect(
			formatThreadComment({ finding, kind: 'bug' }, LINKS, true)
		).toContain('```suggestion\nnew()\n```')
		expect(
			formatThreadComment({ finding, kind: 'bug' }, LINKS, false)
		).not.toContain('```suggestion')
	})
})
