import {
	type ConfirmedEdit,
	type KeptFinding,
	MAX_EDIT_CHARS,
	MAX_EDIT_LINES,
} from '@mng-review/domain'
import {
	getCodeBlocks,
	HOSTILE_TEXT,
	toTextOutsideCode,
} from '../../../shared/mocks/hostile-text.helper'
import { bug, LINKS } from '../../../shared/mocks/publish-test.helper'
import { escapeMarkdown } from '../../../utils/markdown.util'
import {
	getSuggestedEdit,
	toFindingBodyLines,
	type FindingPlace,
} from './finding-body.formatter'

const EDIT = {
	commit: LINKS.head,
	line: bug().line,
	original: '\told()',
	replacement: '\tnew()',
} as const satisfies ConfirmedEdit

/** A publishable finding carrying a validator-confirmed line edit. */
function confirmed(edit: ConfirmedEdit = EDIT): KeptFinding {
	return bug({
		validation: {
			status: 'confirmed',
			severity: 'high',
			reason: 'The write repeats.',
			evidence: ['src/store.ts:10'],
			model: 'provider/claude-opus-5-5',
			edit,
		},
	})
}

/** The rendered body without its heading or hidden matching marker. */
function body(finding: KeptFinding, place: FindingPlace = 'line'): string {
	return toFindingBodyLines(finding, LINKS, place).join('\n')
}

describe('getSuggestedEdit', () => {
	test('keeps a confirmed edit at the same head and finding line', () => {
		expect(getSuggestedEdit(confirmed(), LINKS, 'line')).toEqual(EDIT)
	})
	test.each(['file', 'summary'] as const)(
		'never suggests an edit in a %s comment',
		place => {
			expect(getSuggestedEdit(confirmed(), LINKS, place)).toBeUndefined()
			expect(
				getCodeBlocks(body(confirmed(), place)).map(block => block.info)
			).not.toContain('suggestion')
		}
	)
	test.each([
		{ ...EDIT, commit: 'other-head' },
		{ ...EDIT, line: EDIT.line + 1 },
		{ ...EDIT, replacement: 'x'.repeat(MAX_EDIT_CHARS + 1) },
		{
			...EDIT,
			replacement: Array.from({ length: MAX_EDIT_LINES + 1 }, () => 'x').join(
				'\n'
			),
		},
		{ ...EDIT, replacement: 'new\u202E()' },
	])('refuses ineligible edit %j', edit => {
		expect(getSuggestedEdit(confirmed(edit), LINKS, 'line')).toBeUndefined()
		expect(
			getCodeBlocks(body(confirmed(edit))).map(block => block.info)
		).not.toContain('suggestion')
	})
	test.each([
		'absent',
		'confirmed without edit',
		'unverified',
		'unvalidated',
	] as const)('never suggests for %s validation', status => {
		const finding =
			status === 'absent'
				? bug()
				: status === 'unvalidated'
					? bug({ validation: { status: 'unvalidated', error: 'No answer.' } })
					: status === 'unverified'
						? bug({
								validation: {
									status: 'unverified',
									severity: 'high',
									reason: 'Unknown.',
									evidence: [],
									model: 'model',
									premise: 'A package retries.',
								},
							})
						: bug({
								validation: {
									status: 'confirmed',
									severity: 'high',
									reason: 'Confirmed.',
									evidence: [],
									model: 'model',
								},
							})
		expect(getSuggestedEdit(finding, LINKS, 'line')).toBeUndefined()
		expect(getCodeBlocks(body(finding)).map(block => block.info)).not.toContain(
			'suggestion'
		)
	})
	test.each([
		'',
		'x'.repeat(MAX_EDIT_CHARS),
		Array.from({ length: MAX_EDIT_LINES }, () => 'x').join('\n'),
	])('accepts a deletion and inclusive size boundaries: %j', replacement => {
		expect(
			getSuggestedEdit(confirmed({ ...EDIT, replacement }), LINKS, 'line')
				?.replacement
		).toBe(replacement)
	})
})

describe('toFindingBodyLines', () => {
	test('puts impact, fix and suggestion above the fold and orders all details before the footer', () => {
		const finding = {
			...confirmed(),
			impact: 'Users lose data.',
			suggestion: 'Use a unique key.',
			trigger: '9. Retry a write\n- Send it again\n* Read the result',
			evidence: ['src/store.ts:10 retry'],
		}
		const text = body(finding)
		const sections = [
			...text.matchAll(
				/<details><summary>([^<]+)<\/summary>\n\n([\s\S]*?)\n\n<\/details>/gu
			),
		]
		expect(text.slice(0, text.indexOf('<details>'))).toBe(
			'Users lose data.\n\n**Fix:** Use a unique key.\n\n```suggestion\n\tnew()\n```\n\n'
		)
		expect(sections.map(section => section[1])).toEqual([
			'How it happens',
			'Evidence (1)',
			'Prompt for an agent',
		])
		expect(sections[0]?.[2]).toBe(
			'1. Retry a write\n2. Send it again\n3. Read the result'
		)
		expect(
			getCodeBlocks(sections[2]?.[2] ?? '').map(block => block.info)
		).toEqual(['text'])
		expect(text).toMatch(
			/<\/details>\n\n<sub>Found by reviewer · confirmed by Opus 5\.5<\/sub>$/u
		)
	})
	test.each(['\n', '\r\n', '\r', '\u2028', '\u2029'])(
		'splits trigger on separator %j and strips numbering and bullets',
		separator => {
			expect(
				body(
					bug({
						trigger: `  12) First${separator}• Second${separator} ${separator}- Third`,
					})
				)
			).toContain('1. First\n2. Second\n3. Third')
		}
	)
	test('a single step stays a sentence and empty optional sections are absent', () => {
		const text = body(
			bug({
				trigger: '- Retry once',
				evidence: [],
				suggestion: undefined,
				agents: [],
			})
		)
		expect(text).toContain(
			'<summary>How it happens</summary>\n\nRetry once\n\n</details>'
		)
		for (const absent of [
			'**Fix:**',
			'Evidence (',
			'Why it does not block',
			'<sub>',
		])
			expect(text).not.toContain(absent)
		expect(body(bug({ trigger: ' \n ' }))).not.toContain(
			'<summary>How it happens'
		)
	})
	test('deduplicates evidence by location, links to the head and caps the displayed count at six', () => {
		const evidence = [
			'src/store.ts:10 first',
			'src/store.ts:10 duplicate',
			'src/range.ts:2-4 range',
			'A plain note',
			'A plain note',
			'src/a.ts:1 a',
			'src/b.ts:2 b',
			'src/c.ts:3 c',
			'src/d.ts:4 omitted',
		]
		const text = body(bug({ evidence }))
		expect(text).toContain('<summary>Evidence (6)</summary>')
		expect(text).toContain(
			`[\`src/store.ts:10\`](${LINKS.serverUrl}/${LINKS.owner}/${LINKS.name}/blob/${LINKS.head}/src/store.ts#L10) first`
		)
		expect(text).toContain(`/blob/${LINKS.head}/src/range.ts#L2-L4) range`)
		expect(text.match(/A plain note/gu)).toHaveLength(1)
		expect(text).not.toContain('duplicate')
		expect(text).not.toContain('omitted')
	})
	test('escapes unlinked evidence and does not link traversal paths', () => {
		const text = body(
			bug({ evidence: [`../escape.ts:1 ${HOSTILE_TEXT}`, HOSTILE_TEXT] })
		)
		expect(text).toContain(escapeMarkdown(`../escape.ts:1 ${HOSTILE_TEXT}`))
		expect(text).not.toContain('/blob/')
	})
	test.each(['confirmed', 'unverified', 'unvalidated', 'absent'] as const)(
		'renders the %s validation footer and file location',
		status => {
			const finding =
				status === 'confirmed'
					? confirmed()
					: status === 'unverified'
						? bug({
								validation: {
									status: 'unverified',
									severity: 'high',
									reason: 'Unknown.',
									evidence: [],
									premise: 'Package retries...',
									model: 'gpt-6.1-sol',
								},
							})
						: status === 'unvalidated'
							? bug({
									validation: { status: 'unvalidated', error: 'No answer.' },
								})
							: bug()
			const text = body({ ...finding, agents: ['a', 'b', 'c'] }, 'file')
			expect(text).toContain(
				`<sub>Line ${finding.line} is outside this pull request's diff · Found by a, b and c`
			)
			const note =
				status === 'confirmed'
					? 'confirmed by Opus 5.5'
					: status === 'unverified'
						? 'left unverified by GPT-6.1 Sol'
						: status === 'unvalidated'
							? 'not validated'
							: 'Found by a, b and c'
			expect(text).toContain(`${note}</sub>`)
			if (status === 'unverified')
				expect(text).toContain(
					'<summary>Why it does not block</summary>\n\nIt rests on Package retries, which this repository neither shows nor rules out.\n\n</details>'
				)
			else expect(text).not.toContain('Why it does not block')
		}
	)
	test.each([['a'], ['a', 'b']].map(agents => ({ agents })))(
		'formats finder names %j',
		({ agents }) => {
			expect(body(bug({ agents }))).toContain(
				`Found by ${agents.join(' and ')}</sub>`
			)
		}
	)
	test('hostile text stays escaped outside code and cannot terminate folded sections or fences', () => {
		const hostile = `${HOSTILE_TEXT}\n\`\`\`\`\`\`\n</details>\n-->`
		const finding = bug({
			title: hostile,
			impact: hostile,
			trigger: hostile,
			suggestion: hostile,
			evidence: [hostile],
			agents: [hostile],
			validation: {
				status: 'unverified',
				severity: 'high',
				reason: hostile,
				evidence: [],
				model: hostile,
				premise: hostile,
			},
		})
		const text = body(finding)
		const outside = toTextOutsideCode(text)
		const summaries = [...text.matchAll(/<summary>(.*?)<\/summary>/gu)].map(
			match => match[1]
		)
		expect(summaries).toEqual([
			'Why it does not block',
			'How it happens',
			'Evidence (1)',
			'Prompt for an agent',
		])
		expect(outside.match(/^<\/details>$/gmu)).toHaveLength(4)
		expect(outside).not.toMatch(/(?<!\\)<img|-->|\p{Cf}/u)
		expect(outside).toContain(escapeMarkdown(HOSTILE_TEXT))
		const blocks = getCodeBlocks(text)
		expect(blocks).toHaveLength(1)
		expect(blocks[0]?.info).toBe('text')
		expect(blocks[0]?.fence.length).toBe(7)
		expect(blocks[0]?.body).toContain('@octocat')
		expect(blocks[0]?.body).toContain('</details>\n-->')
		expect(blocks[0]?.body).not.toMatch(/\p{Cf}/u)
	})
	test('suggestion preserves printable code and fences all hostile backtick runs', () => {
		const replacement = `${HOSTILE_TEXT.replaceAll(/\p{Cf}/gu, '')}\n\`\`\`\`\`\`\n</details>\n-->`
		const text = body(confirmed({ ...EDIT, replacement }))
		const blocks = getCodeBlocks(text)
		expect(blocks.filter(block => block.info === 'suggestion')).toEqual([
			{ info: 'suggestion', fence: '`'.repeat(7), body: replacement },
		])
		expect(toTextOutsideCode(text)).not.toContain('@octocat')
	})
	test('an empty replacement renders an empty suggestion block', () => {
		expect(body(confirmed({ ...EDIT, replacement: '' }))).toContain(
			'```suggestion\n```'
		)
	})
})
