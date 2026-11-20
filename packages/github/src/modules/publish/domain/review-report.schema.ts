import {
	AGENT_INPUTS,
	AGENT_KINDS,
	commitShaSchema,
	countSchema,
	DEPTHS,
	effortSchema,
	MECHANICAL_CONDITIONS,
	normalizeRepoPath,
	RISK_CATEGORIES,
	RISK_LEVELS,
	severitySchema,
} from '@mng-review/domain'
import { Effect, Schema } from 'effect'

/** Most entries in each finding list, the agent reports, and the plan's runs and skips. */
export const MAX_REPORT_ENTRIES = 500
/** Most changed files a report lists. */
export const MAX_REPORT_FILES = 5000
/** Most characters in any one string of a report. */
export const MAX_REPORT_TEXT = 20_000
const textSchema = Schema.String.check(Schema.isMaxLength(MAX_REPORT_TEXT))
const textListSchema = Schema.Array(textSchema)
/** A repository-relative path as `normalizeRepoPath` returns it; nothing absolute or outside. */
const repoPathSchema = textSchema.check(
	Schema.makeFilter(
		(path: string) =>
			normalizeRepoPath(path) === path || 'must be a repository-relative path'
	)
)
const agentKindSchema = Schema.Literals(AGENT_KINDS)

/** A list of at most `max` entries; a longer one fails the decode, never gets cut. */
function boundedList<TSchema extends Schema.Top>(
	schema: TSchema,
	max: number = MAX_REPORT_ENTRIES
) {
	return Schema.Array(schema).check(Schema.isMaxLength(max))
}

const modelTokensSchema = Schema.Struct({
	calls: countSchema,
	inputTokens: countSchema,
	cachedInputTokens: countSchema,
	outputTokens: countSchema,
	reasoningTokens: countSchema,
	totalTokens: countSchema,
})
/** Tokens by model name, as the engine's token ledger counts them. */
export const tokensByModelSchema = Schema.Record(textSchema, modelTokensSchema)
const tokensBySourceSchema = Schema.Record(
	textSchema,
	Schema.Struct({
		...modelTokensSchema.fields,
		conversations: countSchema,
		firstMessageTokens: countSchema,
		historyTokens: countSchema,
	})
)

const findingFields = {
	path: repoPathSchema,
	line: countSchema,
	severity: severitySchema,
	title: textSchema,
	trigger: textSchema,
	impact: textSchema,
	evidence: textListSchema,
	suggestion: Schema.optional(textSchema),
	kind: agentKindSchema,
	agents: textListSchema,
	models: textListSchema,
	fingerprint: textSchema,
}

const judgementFields = {
	severity: severitySchema,
	reason: textSchema,
	evidence: textListSchema,
	model: textSchema,
	loweredBecause: Schema.optional(textSchema),
	note: Schema.optional(textSchema),
}

/** The three answers a finding's validation can hold: a judgement, unverified, or none. */
const validationSchema = Schema.Union([
	Schema.Struct({
		status: Schema.Literals(['confirmed', 'rejected']),
		...judgementFields,
	}),
	Schema.Struct({
		status: Schema.Literal('unverified'),
		...judgementFields,
		premise: textSchema,
	}),
	Schema.Struct({
		status: Schema.Literal('unvalidated'),
		error: textSchema,
		budgetSpent: Schema.optional(Schema.Boolean),
	}),
])

const keptFindingSchema = Schema.Struct({
	...findingFields,
	placement: Schema.Literals(['inline', 'summary']),
	reportedSeverity: Schema.optional(severitySchema),
	validation: Schema.optional(validationSchema),
})

const rejectedFindingSchema = Schema.Struct({
	...findingFields,
	reason: textSchema,
	validatedBy: textSchema,
})

const changedFileSchema = Schema.Struct({
	path: repoPathSchema,
	oldPath: Schema.optional(repoPathSchema),
	status: Schema.Literals([
		'added',
		'modified',
		'deleted',
		'renamed',
		'copied',
		'type_changed',
	]),
	additions: countSchema,
	deletions: countSchema,
	binary: Schema.Boolean,
	sizeBytes: countSchema,
	skipped: Schema.optional(
		Schema.Literals(['skip.paths', 'binary', 'too_large'])
	),
})

const resolvedRefSchema = Schema.Struct({
	ref: textSchema,
	commit: commitShaSchema,
})

const routerReportSchema = Schema.Struct({
	status: Schema.Literals(['ok', 'failed', 'skipped']),
	detail: Schema.optional(textSchema),
	risk: Schema.optional(Schema.Literals(RISK_LEVELS)),
	signals: Schema.optional(
		Schema.Array(
			Schema.Struct({
				category: Schema.Literals(RISK_CATEGORIES),
				path: textSchema,
				reason: textSchema,
			})
		)
	),
	added: Schema.Array(Schema.Struct({ agent: textSchema, reason: textSchema })),
})

const plannedRunSchema = Schema.Struct({
	name: textSchema,
	title: textSchema,
	role: Schema.Literals(['reviewer', 'agent']),
	kind: agentKindSchema,
	input: Schema.Literals(AGENT_INPUTS),
	model: textSchema,
	effort: effortSchema,
	files: Schema.Array(repoPathSchema),
	selectedBy: Schema.Literals(['default', 'paths', 'router']),
	reason: Schema.optional(textSchema),
})

const planSchema = Schema.Struct({
	/** `JSON.stringify` drops it when no skip is set; the plan's type keeps the key. */
	skippedRun: Schema.UndefinedOr(textSchema).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed(undefined))
	),
	files: boundedList(changedFileSchema, MAX_REPORT_FILES),
	risk: Schema.Literals(RISK_LEVELS),
	riskSource: Schema.Literals([
		'risk_paths',
		'mechanical',
		'router',
		'default',
	]),
	riskPathHits: textListSchema,
	shape: Schema.optional(
		Schema.Struct({
			files: countSchema,
			smallShare: Schema.Finite,
			netShare: Schema.Finite,
			riskyRewrites: textListSchema,
			failed: Schema.Array(Schema.Literals(MECHANICAL_CONDITIONS)),
		})
	),
	depth: Schema.Literals(DEPTHS),
	depthSource: textSchema,
	router: routerReportSchema,
	runs: boundedList(plannedRunSchema),
	skips: boundedList(
		Schema.Struct({ name: textSchema, title: textSchema, reason: textSchema })
	),
})

const agentRunReportSchema = Schema.Struct({
	name: textSchema,
	title: textSchema,
	kind: agentKindSchema,
	model: textSchema,
	effort: effortSchema,
	status: Schema.Literals(['ok', 'incomplete', 'failed']),
	error: Schema.optional(textSchema),
	endpointError: Schema.optional(Schema.Boolean),
	fellBackFrom: Schema.optional(textSchema),
	toolCalls: countSchema,
	findings: countSchema,
	malformed: countSchema,
	units: Schema.optional(countSchema),
	continued: Schema.optional(countSchema),
	unfinished: Schema.optional(textListSchema),
	wallMillis: countSchema,
})

/**
 * The engine's `ReviewReport` as it crosses from the review to publishing in the outcome file.
 * Paths are repository-relative, commits are full SHAs, and every list and string is bounded; a
 * report over a bound fails the decode. Keys the schema does not name are dropped.
 */
export const reviewReportSchema = Schema.Struct({
	bugs: boundedList(keptFindingSchema),
	nits: boundedList(keptFindingSchema),
	rejected: boundedList(rejectedFindingSchema),
	planReport: Schema.Struct({
		change: Schema.Struct({
			base: resolvedRefSchema,
			head: resolvedRefSchema,
			mergeBase: commitShaSchema,
			files: boundedList(changedFileSchema, MAX_REPORT_FILES),
		}),
		plan: planSchema,
		rulesSource: textSchema,
		tokens: tokensByModelSchema,
	}),
	agents: boundedList(agentRunReportSchema),
	tokens: tokensByModelSchema,
	tokenSources: tokensBySourceSchema,
	droppedModels: Schema.Array(
		Schema.Struct({ model: textSchema, reason: textSchema })
	),
	wallMillis: countSchema,
	endpointError: Schema.optional(textSchema),
	incomplete: Schema.optional(
		Schema.Struct({ reason: textSchema, unfinished: textListSchema })
	),
	blocking: Schema.Boolean,
})
export type DecodedReviewReport = typeof reviewReportSchema.Type
