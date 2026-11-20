import { Option, Schema } from 'effect'
import {
	type FindingMarker,
	findingMarkerSchema,
	type ReplyMarker,
	replyMarkerSchema,
	type SummaryMarker,
	summaryMarkerSchema,
} from './publish-marker.schema'
import { MARKER_PREFIX } from './publish.constants'

/** The marker comment that ends a body: `<!-- mng-review:<name> <json> -->`, its JSON on one line. */
const MARKER_PATTERN = new RegExp(
	String.raw`<!-- ${MARKER_PREFIX}(finding|summary|reply) (\{[^\n]*\}) -->\s*$`,
	'u'
)
const decodeFinding = Schema.decodeUnknownOption(
	Schema.fromJsonString(findingMarkerSchema)
)
const decodeSummary = Schema.decodeUnknownOption(
	Schema.fromJsonString(summaryMarkerSchema)
)
const decodeReply = Schema.decodeUnknownOption(
	Schema.fromJsonString(replyMarkerSchema)
)

/** The kinds of hidden marker the bot writes. */
type MarkerName = 'finding' | 'summary' | 'reply'

/** The JSON of the marker of that name that ends the body; the bot always writes its marker last. */
function getLastMarkerJson(body: string, name: MarkerName): string | undefined {
	const match = MARKER_PATTERN.exec(body)
	return match?.[1] === name ? match[2] : undefined
}

/** True when the body ends with a marker of the bot's form, whether or not it decodes. */
export function hasBotMarker(body: string): boolean {
	return MARKER_PATTERN.test(body)
}

/** The finding marker of a comment body, or `undefined` when it has none or it does not decode. */
export function parseFindingMarker(body: string): FindingMarker | undefined {
	const json = getLastMarkerJson(body, 'finding')
	return json === undefined
		? undefined
		: Option.getOrUndefined(decodeFinding(json))
}

/** The summary marker of a comment body, or `undefined` when it has none or it does not decode. */
export function parseSummaryMarker(body: string): SummaryMarker | undefined {
	const json = getLastMarkerJson(body, 'summary')
	return json === undefined
		? undefined
		: Option.getOrUndefined(decodeSummary(json))
}

/** The reply marker of a comment body, or `undefined` when it has none or it does not decode. */
export function parseReplyMarker(body: string): ReplyMarker | undefined {
	const json = getLastMarkerJson(body, 'reply')
	return json === undefined
		? undefined
		: Option.getOrUndefined(decodeReply(json))
}
