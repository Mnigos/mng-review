import type { KeptFinding, Severity } from '@mng-review/domain'
import { escapeMarkdown, toCodeSpan } from '../../../utils/markdown.util'
import type { FindingMarker, ThreadKind } from '../domain/publish-marker.schema'
import {
	MARKER_PREFIX,
	MARKER_VERSION,
	SHORT_SHA_LENGTH,
} from '../domain/publish.constants'
import type { PublishedFinding } from '../domain/publish.types'

/** `path:line` or `path:start-end` at the start of an evidence line, the path made of safe characters only. */
const EVIDENCE_PLACE = /^([\w./-]+):(\d+)(?:-(\d+))?\b[\s,:;-]*(.*)$/su
const MAX_EVIDENCE = 6
/** Characters of a title kept in a comment and its marker. */
const MAX_TITLE_CHARS = 300
/**
 * Characters of a trigger, impact, premise, fix or evidence line kept, so a comment stays far below
 * GitHub's 65,536 characters even after escaping and with the marker.
 */
export const MAX_TEXT_CHARS = 3000

/** Where evidence links point: the repository on its server at the reviewed head, and the engine that posts. */
export interface BlobLinks {
	readonly serverUrl: string
	readonly owner: string
	readonly name: string
	readonly head: string
	readonly engineCommit: string | undefined
}

/** Where the repository is and the commits a publish call is about. */
export interface LinkTarget {
	readonly head: string
	readonly engineCommit: string | undefined
}

/** Links to the configured repository at the target's head. */
export function toBlobLinks(
	repository: Pick<BlobLinks, 'serverUrl' | 'owner' | 'name'>,
	target: LinkTarget
): BlobLinks {
	return {
		serverUrl: repository.serverUrl,
		owner: repository.owner,
		name: repository.name,
		head: target.head,
		engineCommit: target.engineCommit,
	}
}

/** Text cut to `max` characters, with an ellipsis when cut. */
export function toShort(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text
}

/** A severity with a capital first letter. */
export function toSeverityLabel(severity: Severity): string {
	return `${severity.charAt(0).toUpperCase()}${severity.slice(1)}`
}

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

/** The heading line: what kind of finding, its severity and its title. */
function toHeading(published: PublishedFinding): string {
	const { finding, kind } = published
	const title = escapeMarkdown(toShort(finding.title, MAX_TITLE_CHARS))
	if (kind === 'nit') return `**Nit** · ${title}`
	if (kind === 'unverified')
		return `**Unverified, ${finding.severity}** · ${title}`
	return `**${toSeverityLabel(finding.severity)}** · ${title}`
}

/** Why an unverified finding does not block, naming the dependency behaviour it rests on. */
function toUnverifiedLines(finding: KeptFinding): string[] {
	if (finding.validation?.status !== 'unverified') return []
	return [
		'',
		`Not blocking: it rests on ${escapeMarkdown(toShort(finding.validation.premise, MAX_TEXT_CHARS))}, which this repository neither shows nor rules out.`,
	]
}

/** Who reported it and what the validator said. */
function toAttribution(finding: KeptFinding): string {
	const agents = finding.agents.map(escapeMarkdown).join(', ')
	const { validation } = finding
	if (validation?.status === 'confirmed')
		return `${agents}, confirmed by ${escapeMarkdown(validation.model)}`
	if (validation?.status === 'unverified')
		return `${agents}, unverified by ${escapeMarkdown(validation.model)}`
	if (validation?.status === 'unvalidated') return `${agents}, not validated`
	return agents
}

/** The hidden marker: JSON on one line with `<`, `>` and `&` escaped, so it cannot close the comment. */
export function toMarkerComment(
	name: 'finding' | 'summary' | 'reply',
	data: object
): string {
	const json = JSON.stringify(data)
		.replaceAll('<', String.raw`\u003c`)
		.replaceAll('>', String.raw`\u003e`)
		.replaceAll('&', String.raw`\u0026`)
	return `<!-- ${MARKER_PREFIX}${name} ${json} -->`
}

/** The marker a finding's thread carries. */
export function toFindingMarker(
	published: PublishedFinding,
	links: BlobLinks
): FindingMarker {
	const { finding, kind } = published
	return {
		v: MARKER_VERSION,
		id: `${finding.fingerprint}-${links.head.slice(0, SHORT_SHA_LENGTH)}`,
		kind,
		agent: finding.agents[0] ?? 'reviewer',
		severity: finding.severity,
		fingerprint: finding.fingerprint,
		title: toShort(finding.title, MAX_TITLE_CHARS),
		line: finding.line,
		trigger: toShort(finding.trigger, MAX_TEXT_CHARS),
		impact: toShort(finding.impact, MAX_TEXT_CHARS),
		engine: links.engineCommit ?? null,
	}
}

/** A line naming the place when the comment sits on the file instead of the line. */
function toPlaceNote(finding: KeptFinding, onFile: boolean): string[] {
	if (!onFile) return []
	return [
		'',
		`Line ${finding.line} is outside this pull request's diff, so this comment is on the file.`,
	]
}

/**
 * What a reader needs to act on a finding, without the heading: trigger and impact, the place note,
 * evidence linked to the head, the fix and who reported it. Every model text is escaped, so it
 * cannot format, link, mention or reference anything.
 */
export function toFindingDetailLines(
	finding: KeptFinding,
	links: BlobLinks,
	onFile: boolean
): string[] {
	const evidence = getDistinctEvidence(finding.evidence).slice(0, MAX_EVIDENCE)
	return [
		`${escapeMarkdown(toShort(finding.trigger, MAX_TEXT_CHARS))} ${escapeMarkdown(toShort(finding.impact, MAX_TEXT_CHARS))}`,
		...toUnverifiedLines(finding),
		...toPlaceNote(finding, onFile),
		...(evidence.length === 0
			? []
			: [
					'',
					'Evidence:',
					...evidence.map(line =>
						toEvidenceItem(toShort(line, MAX_TEXT_CHARS), links)
					),
				]),
		...(finding.suggestion
			? [
					'',
					`Fix: ${escapeMarkdown(toShort(finding.suggestion, MAX_TEXT_CHARS))}`,
				]
			: []),
		'',
		`<sub>${toAttribution(finding)}</sub>`,
	]
}

/** Characters a comment may hold; GitHub refuses a longer body. */
export const MAX_COMMENT_CHARS = 65_000
/** What a comment says in place of details that would not fit in it. */
const TOO_LONG_NOTE =
	'The details are too long for one comment; the job summary has the run.'

/**
 * The first comment of a finding's thread: heading, details and the hidden marker. Details that
 * would push the body past what GitHub accepts are left out, never the heading or the marker.
 */
export function formatThreadComment(
	published: PublishedFinding,
	links: BlobLinks,
	onLine: boolean
): string {
	const heading = toHeading(published)
	const marker = toMarkerComment('finding', toFindingMarker(published, links))
	const full = [
		heading,
		'',
		...toFindingDetailLines(published.finding, links, !onLine),
		'',
		marker,
	].join('\n')
	if (full.length <= MAX_COMMENT_CHARS) return full
	return [heading, '', TOO_LONG_NOTE, '', marker].join('\n')
}

/** A kind and severity for the summary list. */
export function toKindLabel(kind: ThreadKind, severity: Severity): string {
	if (kind === 'nit') return 'Nit'
	if (kind === 'unverified') return `Unverified, ${severity}`
	return toSeverityLabel(severity)
}

/**
 * The bot's reply when its finding no longer holds: the head, why, and that it stops counting the
 * thread. `reply` is the author's comment it answers, unset for a re-check.
 */
export function formatResolvedReply(
	reason: string,
	links: BlobLinks,
	reply?: number
): string {
	const head = toCodeSpan(links.head.slice(0, SHORT_SHA_LENGTH))
	return [
		`No longer found at ${head}: ${escapeMarkdown(toShort(reason, MAX_TEXT_CHARS))} The bot no longer counts this thread as open.`,
		'',
		toMarkerComment('reply', {
			v: MARKER_VERSION,
			action: 'resolved',
			commit: links.head,
			...(reply === undefined ? {} : { reply }),
		}),
	].join('\n')
}
