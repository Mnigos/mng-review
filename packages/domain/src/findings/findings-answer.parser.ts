import { Effect, Option, Schema } from 'effect'
import { normalizeRepoPath } from '../utils/repo-path.util'
import { FindingsAnswerError } from './finding.errors'
import {
	findingsAnswerSchema,
	type ReportedFinding,
	reportedFindingSchema,
} from './finding.schema'

const decodeAnswer = Schema.decodeUnknownEffect(findingsAnswerSchema)
const decodeReportedFinding = Schema.decodeUnknownOption(reportedFindingSchema)

/** The findings of an answer and how many malformed entries were dropped. */
export interface ParsedFindings {
	readonly findings: readonly ReportedFinding[]
	readonly dropped: number
}

/** Decodes one entry; `undefined` for a malformed entry or a path outside the repository. */
function toReportedFinding(entry: unknown): ReportedFinding | undefined {
	const finding = decodeReportedFinding(entry)
	if (Option.isNone(finding)) return undefined
	const path = normalizeRepoPath(finding.value.path)
	if (path === undefined || path === '.') return undefined
	return { ...finding.value, path }
}

/**
 * Reads a model's findings answer. Entries that do not fit the finding schema, and absolute or
 * traversing paths, are dropped and counted; an answer without a findings list fails.
 */
export function parseFindingsAnswer(
	answer: unknown
): Effect.Effect<ParsedFindings, FindingsAnswerError> {
	return decodeAnswer(answer).pipe(
		Effect.mapError(
			() =>
				new FindingsAnswerError({
					message: 'expected an object with a "findings" array',
				})
		),
		Effect.map(decoded => {
			const entries = 'findings' in decoded ? decoded.findings : decoded
			const findings = entries.flatMap(entry => toReportedFinding(entry) ?? [])
			return { findings, dropped: entries.length - findings.length }
		})
	)
}
