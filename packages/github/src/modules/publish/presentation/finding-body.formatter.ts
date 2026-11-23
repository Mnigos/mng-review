import {
	type ConfirmedEdit,
	isPlainCode,
	type KeptFinding,
	MAX_EDIT_CHARS,
	MAX_EDIT_LINES,
} from '@mng-review/domain'
import {
	escapeMarkdown,
	toCodeBlock,
	toCodeSpan,
	toShort,
} from '../../../utils/markdown.util'
import { toModelName } from '../domain/model-name.helper'
import { MAX_TEXT_CHARS } from '../domain/publish.constants'
import type { BlobLinks } from './thread-comment.formatter'

/** `path:line` or `path:start-end` at the start of an evidence line, the path made of safe characters only. */
const EVIDENCE_PLACE = /^([\w./-]+):(\d+)(?:-(\d+))?\b[\s,:;-]*(.*)$/su
const MAX_EVIDENCE = 6
/** A number or bullet a model put before a step; the list numbers the steps itself. */
const STEP_MARKER = /^\s*(?:\d+[.)]|[-*•])\s+/u

/**
 * Where a finding's text goes: its thread on the line, which may carry a suggested change, its
 * thread on the file, or the review body.
 */
export type FindingPlace = 'line' | 'file' | 'summary'

/** A link to a line or range of a file at the head; the path is percent-encoded per segment. */
function toBlobLink(place: RegExpExecArray, links: BlobLinks): string {
	const [, path = '', start = '', end] = place
	const encoded = path.split('/').map(encodeURIComponent).join('/')
	const anchor = end ? `#L${start}-L${end}` : `#L${start}`
	const label = end ? `${path}:${start}-${end}` : `${path}:${start}`
	return `[${toCodeSpan(label)}](${links.serverUrl}/${links.owner}/${links.name}/blob/${links.head}/${encoded}${anchor})`
}

/**
 * Evidence lines with one entry per place: merged findings often cite the same `path:line` in
 * other words, and the first one is kept. Lines without a place are kept once each.
 */
function getDistinctEvidence(evidence: readonly string[]): string[] {
	const seen = new Set<string>()
	return evidence.filter(line => {
		const place = EVIDENCE_PLACE.exec(line.trim())
		const key = place ? `${place[1]}:${place[2]}-${place[3] ?? ''}` : line
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})
}

/** One evidence line: its `path:line` as a link to the head, the rest escaped. */
function toEvidenceItem(evidence: string, links: BlobLinks): string {
	const place = EVIDENCE_PLACE.exec(evidence.trim())
	if (!place || place[1]?.includes('..')) return `- ${escapeMarkdown(evidence)}`
	const rest = place[4] ? ` ${escapeMarkdown(place[4])}` : ''
	return `- ${toBlobLink(place, links)}${rest}`
}

/** Model text cut to `MAX_TEXT_CHARS`. */
function toCut(text: string): string {
	return toShort(text, MAX_TEXT_CHARS)
}

/** Model text cut to `MAX_TEXT_CHARS`, then escaped for one line. */
function toLine(text: string): string {
	return escapeMarkdown(toCut(text))
}

/**
 * A folded section. The `<summary>` is raw HTML, where Markdown escapes do not apply, so callers
 * pass only fixed text; the blank lines let Markdown apply to the lines inside.
 */
function toDetails(summary: string, lines: readonly string[]): string[] {
	return [
		'',
		`<details><summary>${summary}</summary>`,
		'',
		...lines,
		'',
		'</details>',
	]
}

/**
 * The validator's confirmed fix when the comment sits on the line it replaces at the head it was
 * checked on, and it is plain code within the edit limits; otherwise none, and no suggestion.
 * Publishing has already dropped an edit whose original text its own read of that line does not
 * show (`ThreadPlaceService.keepCheckedEdits`).
 */
export function getSuggestedEdit(
	finding: KeptFinding,
	links: Pick<BlobLinks, 'head'>,
	place: FindingPlace
): ConfirmedEdit | undefined {
	const { validation } = finding
	if (place !== 'line' || validation?.status !== 'confirmed') return undefined
	const { edit } = validation
	if (!edit || edit.commit !== links.head || edit.line !== finding.line)
		return undefined
	const { replacement } = edit
	if (!isPlainCode(replacement) || replacement.length > MAX_EDIT_CHARS)
		return undefined
	return replacement.split('\n').length > MAX_EDIT_LINES ? undefined : edit
}

/** The fix line and, when the validator confirmed it as one edit of this line, the suggestion. */
function toFixLines(
	finding: KeptFinding,
	links: BlobLinks,
	place: FindingPlace
): string[] {
	const edit = getSuggestedEdit(finding, links, place)
	return [
		...(finding.suggestion
			? ['', `**Fix:** ${toLine(finding.suggestion)}`]
			: []),
		...(edit ? ['', toCodeBlock(edit.replacement, 'suggestion')] : []),
	]
}

/** Why an unverified finding does not block, naming the dependency behaviour it rests on. */
function toUnverifiedSection(finding: KeptFinding): string[] {
	if (finding.validation?.status !== 'unverified') return []
	return toDetails('Why it does not block', [
		`It rests on ${toLine(finding.validation.premise.replace(/[\s.]+$/u, ''))}, which this repository neither shows nor rules out.`,
	])
}

/** The trigger as numbered steps, one per line the finder wrote; a single step stays a sentence. */
function toStepsSection(finding: KeptFinding): string[] {
	const steps = toCut(finding.trigger)
		.split(/\r\n|[\n\r\p{Zl}\p{Zp}]/u)
		.map(step => step.replace(STEP_MARKER, '').trim())
		.filter(Boolean)
	if (steps.length === 0) return []
	const [only] = steps
	if (steps.length === 1 && only)
		return toDetails('How it happens', [escapeMarkdown(only)])
	return toDetails(
		'How it happens',
		steps.map((step, index) => `${index + 1}. ${escapeMarkdown(step)}`)
	)
}

/** The distinct evidence lines, linked to the head, with how many there are. */
function toEvidenceSection(finding: KeptFinding, links: BlobLinks): string[] {
	const evidence = getDistinctEvidence(finding.evidence).slice(0, MAX_EVIDENCE)
	if (evidence.length === 0) return []
	return toDetails(
		`Evidence (${evidence.length})`,
		evidence.map(line => toEvidenceItem(toCut(line), links))
	)
}

/**
 * The finding as plain text for a coding agent: place, problem, steps and fix, in a code block, so
 * none of the model's text renders, links or mentions anyone.
 */
function toAgentPromptSection(finding: KeptFinding): string[] {
	const prompt = [
		`In ${finding.path} at line ${finding.line}: ${toCut(finding.title)}`,
		'',
		toCut(finding.impact),
		'',
		'How it happens:',
		toCut(finding.trigger),
		...(finding.suggestion
			? ['', `What to change: ${toCut(finding.suggestion)}`]
			: []),
		'',
		'Check the finding against the code first, and fix it only if it holds.',
	].join('\n')
	return toDetails('Prompt for an agent', [toCodeBlock(prompt, 'text')])
}

/** Names as prose: `a`, `a and b`, `a, b and c`. */
function toNameList(names: readonly string[]): string {
	if (names.length <= 1) return names.join('')
	return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/** What the validator made of the finding, its model named as people know it. */
function toValidationNote(finding: KeptFinding): string[] {
	const { validation } = finding
	if (!validation) return []
	if (validation.status === 'unvalidated') return ['not validated']
	const model = escapeMarkdown(toModelName(validation.model))
	if (validation.status === 'unverified') return [`left unverified by ${model}`]
	return validation.status === 'confirmed' ? [`confirmed by ${model}`] : []
}

/** The footer: where the comment sits when not on the line, who found the finding and who confirmed it. */
function toFooter(finding: KeptFinding, place: FindingPlace): string[] {
	const parts = [
		...(place === 'file'
			? [`Line ${finding.line} is outside this pull request's diff`]
			: []),
		...(finding.agents.length > 0
			? [`Found by ${toNameList(finding.agents.map(escapeMarkdown))}`]
			: []),
		...toValidationNote(finding),
	]
	return parts.length === 0 ? [] : ['', `<sub>${parts.join(' · ')}</sub>`]
}

/**
 * A finding's text below its heading. Above the fold: the impact and the fix, with a suggested
 * change when the validator confirmed one for this line. Folded: why an unverified finding does not
 * block, how it happens, the evidence linked to the head and a prompt for a coding agent. Then the
 * footer. Every model text is escaped or inside a code block, so it cannot format, link, mention or
 * reference anything.
 */
export function toFindingBodyLines(
	finding: KeptFinding,
	links: BlobLinks,
	place: FindingPlace
): string[] {
	return [
		toLine(finding.impact),
		...toFixLines(finding, links, place),
		...toUnverifiedSection(finding),
		...toStepsSection(finding),
		...toEvidenceSection(finding, links),
		...toAgentPromptSection(finding),
		...toFooter(finding, place),
	]
}
