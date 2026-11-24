import {
	AGENT_INPUTS,
	AGENT_KINDS,
	commitShaSchema,
	countSchema,
	DEPTHS,
	effortSchema,
	FINGERPRINT_LENGTH,
	MECHANICAL_CONDITIONS,
	normalizeRepoPath,
	RATED_LEVELS,
	RISK_CATEGORIES,
	RISK_LEVELS,
	RULES_DIGEST_PATTERN,
	severitySchema,
	UNRATED_REASONS,
} from '@mng-review/domain'
import {
	MAX_RISK_DETAIL_CHARS,
	MAX_RISK_DIRECTION_CHARS,
	MAX_RISK_REASON_CHARS,
	MAX_RISK_REASONS,
	MAX_RISK_REF_CHARS,
	MAX_RISK_REFS,
	UNREAD_REASONS,
} from '@mng-review/engine'
import { Effect, Schema } from 'effect'

/** Most entries in each finding list, the agent reports, and the plan's runs and skips. */
export const MAX_REPORT_ENTRIES = 500
/** Most changed files a report lists. */
export const MAX_REPORT_FILES = 50_000
/** Most characters in any one string of a report. */
export const MAX_REPORT_TEXT = 20_000
const textSchema = Schema.String.check(Schema.isMaxLength(MAX_REPORT_TEXT))
const textListSchema = Schema.Array(textSchema)
/** Most characters in a name: an agent, a model, a unit. */
export const MAX_REPORT_NAME = 200
const nameSchema = Schema.String.check(Schema.isMaxLength(MAX_REPORT_NAME))
/** Most names in one list: the agents or models of a merged finding. */
export const MAX_REPORT_NAMES = 50
const nameListSchema = Schema.Array(nameSchema).check(
	Schema.isMaxLength(MAX_REPORT_NAMES)
)
/** A finding's fingerprint as the engine makes it: a fixed number of lowercase hex characters. */
const fingerprintSchema = Schema.String.check(
	Schema.isPattern(new RegExp(`^[0-9a-f]{${FINGERPRINT_LENGTH}}$`, 'u'))
)
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
	agents: nameListSchema,
	models: nameListSchema,
	fingerprint: fingerprintSchema,
	cutTitleFingerprint: Schema.optional(fingerprintSchema),
} as const

const judgementFields = {
	severity: severitySchema,
	reason: textSchema,
	evidence: textListSchema,
	model: textSchema,
	loweredBecause: Schema.optional(textSchema),
	note: Schema.optional(textSchema),
	/** A confirmed one-line fix the engine checked at `commit`; only a confirmation sets it. */
	edit: Schema.optional(
		Schema.Struct({
			commit: commitShaSchema,
			/** The head line the edit replaces; lines start at 1. */
			line: countSchema.check(Schema.isGreaterThanOrEqualTo(1)),
			/** That line's exact text at `commit`; publishing compares it with its own read. */
			original: textSchema,
			replacement: textSchema,
		})
	),
} as const

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
	// A file name as git gives it; only finding paths, which place comments, must be repository paths.
	path: textSchema,
	oldPath: Schema.optional(textSchema),
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
				path: repoPathSchema,
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
	unread: Schema.optional(countSchema),
	unreadFiles: Schema.optional(
		boundedList(
			Schema.Struct({
				path: textSchema,
				reason: Schema.Literals(UNREAD_REASONS),
			}),
			MAX_REPORT_FILES
		)
	),
	unfinished: Schema.optional(textListSchema),
	wallMillis: countSchema,
})

const ratedLevelSchema = Schema.Literals(RATED_LEVELS)

/** A floor the complete change hits, with its paths and their summed line counts. */
const floorHitSchema = Schema.Struct({
	name: nameSchema,
	level: ratedLevelSchema,
	builtIn: Schema.Boolean,
	paths: boundedList(textSchema, MAX_REPORT_FILES),
	added: countSchema,
	deleted: countSchema,
})

/** A rating string at most `max` characters, the engine's cut for it. */
function riskTextSchema(max: number) {
	return Schema.String.check(Schema.isMaxLength(max))
}

/** What every rating names: the head, the merge base, the rules digest and the floors. */
const ratingBindingFields = {
	head: commitShaSchema,
	base: commitShaSchema,
	rules: Schema.String.check(Schema.isPattern(RULES_DIGEST_PATTERN)),
	floors: boundedList(floorHitSchema),
	floor: Schema.Boolean,
} as const

/**
 * The engine's risk rating. Publish shows its reasons and recomputes the floors from its own git
 * read; it never takes the floors or a level from here as a permission.
 */
const riskRatingSchema = Schema.Union([
	Schema.Struct({
		...ratingBindingFields,
		status: Schema.Literal('rated'),
		level: ratedLevelSchema,
		model: ratedLevelSchema,
		reasons: boundedList(
			riskTextSchema(MAX_RISK_REASON_CHARS),
			MAX_RISK_REASONS
		).check(Schema.isMinLength(1)),
		refs: boundedList(riskTextSchema(MAX_RISK_REF_CHARS), MAX_RISK_REFS),
		up: Schema.optional(riskTextSchema(MAX_RISK_DIRECTION_CHARS)),
		down: Schema.optional(riskTextSchema(MAX_RISK_DIRECTION_CHARS)),
		rater: nameSchema,
	}),
	Schema.Struct({
		...ratingBindingFields,
		status: Schema.Literal('unrated'),
		reason: Schema.Literals(UNRATED_REASONS),
		detail: riskTextSchema(MAX_RISK_DETAIL_CHARS),
	}),
])

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
	capped: Schema.optional(
		Schema.Struct({ needed: countSchema, cap: countSchema })
	),
	blocking: Schema.Boolean,
	rating: Schema.optional(riskRatingSchema),
})
export type DecodedReviewReport = typeof reviewReportSchema.Type
