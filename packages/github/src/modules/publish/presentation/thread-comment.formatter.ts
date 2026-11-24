import type { Severity } from '@mng-review/domain'
import {
	escapeMarkdown,
	toCodeSpan,
	toShort,
} from '../../../utils/markdown.util'
import type { MarkerName } from '../domain/publish-marker.parser'
import type {
	FindingMarker,
	ReplyMarker,
	ThreadKind,
} from '../domain/publish-marker.schema'
import {
	MARKER_PREFIX,
	MARKER_VERSION,
	MAX_TEXT_CHARS,
	SEVERITY_MARKERS,
	SHORT_SHA_LENGTH,
	UNVERIFIED_MARKER,
} from '../domain/publish.constants'
import type { PublishedFinding } from '../domain/publish.types'
import { toFindingBodyLines } from './finding-body.formatter'

/** Characters of a title kept in a comment and its marker. */
const MAX_TITLE_CHARS = 300

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

/** A severity with a capital first letter. */
export function toSeverityLabel(severity: Severity): string {
	return `${severity.charAt(0).toUpperCase()}${severity.slice(1)}`
}

/** The marker before a kind's name: the severity's for a bug, its own for an unverified finding, none for a nit. */
function toKindMarker(
	kind: ThreadKind,
	severity: Severity
): string | undefined {
	if (kind === 'nit') return undefined
	return kind === 'unverified' ? UNVERIFIED_MARKER : SEVERITY_MARKERS[severity]
}

/** A kind and severity in words: `Nit`, `Unverified, medium` or `Medium`. */
function toKindName(kind: ThreadKind, severity: Severity): string {
	if (kind === 'nit') return 'Nit'
	if (kind === 'unverified') return `Unverified, ${severity}`
	return toSeverityLabel(severity)
}

/** A kind and severity as plain text, its marker first, for raw HTML such as a `<summary>`. */
export function toKindLabel(kind: ThreadKind, severity: Severity): string {
	const marker = toKindMarker(kind, severity)
	const name = toKindName(kind, severity)
	return marker ? `${marker} ${name}` : name
}

/** A kind and severity for Markdown: its marker, then its name in bold, as threads and lists show it. */
export function toKindTag(kind: ThreadKind, severity: Severity): string {
	const marker = toKindMarker(kind, severity)
	const name = `**${toKindName(kind, severity)}**`
	return marker ? `${marker} ${name}` : name
}

/** The heading line: the kind's tag and the title. */
function toHeading(published: PublishedFinding): string {
	const { finding, kind } = published
	const title = escapeMarkdown(toShort(finding.title, MAX_TITLE_CHARS))
	return `${toKindTag(kind, finding.severity)} · ${title}`
}

/** The hidden marker: JSON on one line with `<`, `>` and `&` escaped, so it cannot close the comment. */
export function toMarkerComment(name: MarkerName, data: object): string {
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
		...(finding.validation?.status === 'confirmed' ? { confirmed: true } : {}),
	}
}

/** Characters a comment may hold; GitHub refuses a longer body. */
export const MAX_COMMENT_CHARS = 65_000
/** What a comment says in place of details that would not fit in it. */
const TOO_LONG_NOTE =
	'The details are too long for one comment; the job summary has the run.'

/**
 * The first comment of a finding's thread: heading, the body (`toFindingBodyLines`) and the hidden
 * marker, which later runs match the thread by. A body that would push the comment past what GitHub
 * accepts is left out, never the heading or the marker.
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
		...toFindingBodyLines(published.finding, links, onLine ? 'line' : 'file'),
		'',
		marker,
	].join('\n')
	if (full.length <= MAX_COMMENT_CHARS) return full
	return [heading, '', TOO_LONG_NOTE, '', marker].join('\n')
}

/**
 * The bot's reply when its finding no longer holds: the head, why, and that it stops counting the
 * thread. `reply` is the author's comment it answers, unset for a re-check.
 */
export function formatResolvedReply(
	reason: string,
	links: BlobLinks,
	reply?: number,
	answers: Pick<ReplyMarker, 'answers'> = {}
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
			...answers,
		}),
	].join('\n')
}
