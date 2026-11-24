import { Option, Schema } from 'effect'
import {
	type RiskMarker,
	riskMarkerSchema,
} from '../../risk/domain/risk-marker.schema'
import {
	type AnswerMarker,
	answerMarkerSchema,
	type FindingMarker,
	findingMarkerSchema,
	type ReplyMarker,
	replyMarkerSchema,
	type SummaryMarker,
	summaryMarkerSchema,
} from './publish-marker.schema'
import { MARKER_PREFIX } from './publish.constants'

/**
 * The marker comment that ends a body: `<!-- mng-review:<name> <json> -->`, its JSON on one line.
 */
const MARKER_PATTERN = new RegExp(
	String.raw`<!-- ${MARKER_PREFIX}(finding|summary|reply|risk|answer) (\{(?:(?!-->)[^\n])*\}) -->\s*$`,
	'u'
)
/** Every risk marker form anywhere in a text, each JSON on one line, whatever follows it. */
const RISK_FORM_PATTERN = new RegExp(
	String.raw`<!-- ${MARKER_PREFIX}risk (\{(?:(?!-->)[^\n])*\}) -->`,
	'gu'
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
const decodeAnswer = Schema.decodeUnknownOption(
	Schema.fromJsonString(answerMarkerSchema)
)
const decodeRisk = Schema.decodeUnknownOption(
	Schema.fromJsonString(riskMarkerSchema)
)

/** The kinds of hidden marker the bot writes. */
export type MarkerName = 'finding' | 'summary' | 'reply' | 'risk' | 'answer'

/**
 * The JSON of the marker of that name that ends the body; the bot always writes its marker last.
 */
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

/** True when the body ends with a risk marker, whether or not it decodes. */
export function hasRiskMarker(body: string): boolean {
	return getLastMarkerJson(body, 'risk') !== undefined
}

/** The risk marker of a comment body, or `undefined` when it has none or it does not decode. */
export function parseRiskMarker(body: string): RiskMarker | undefined {
	const json = getLastMarkerJson(body, 'risk')
	return json === undefined
		? undefined
		: Option.getOrUndefined(decodeRisk(json))
}

/**
 * Every risk marker form anywhere in a text that decodes, in the order they appear. Only edited
 * text a person may have written is read this way; a trusted comment's marker is its last one.
 */
export function parseRiskMarkerForms(body: string): RiskMarker[] {
	return [...body.matchAll(RISK_FORM_PATTERN)].flatMap(match =>
		match[1] === undefined ? [] : Option.toArray(decodeRisk(match[1]))
	)
}

/**
 * The answer marker of a denial or cap reply, or `undefined` when it has none or it does not
 * decode.
 */
export function parseAnswerMarker(body: string): AnswerMarker | undefined {
	const json = getLastMarkerJson(body, 'answer')
	return json === undefined
		? undefined
		: Option.getOrUndefined(decodeAnswer(json))
}
