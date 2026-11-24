import { Effect, Schema, SchemaGetter } from 'effect'
import {
	floorLevelSchema,
	type RiskLevel,
} from '../risk/risk-description.schema'
import {
	DEFAULT_FLOOR_LEVEL,
	FLOOR_NAME_PATTERN,
	LABEL_MAX_LENGTH,
	RESERVED_LABELS,
	VALIDATOR_RISK_MODEL,
} from '../risk/risk.constants'
import {
	BOT_SLUG_PATTERN,
	CROSS_VALIDATOR,
	DEFAULT_PRESET_NAME,
	DEPTH_SETTINGS,
	EFFORTS,
	FEATURE_MODES,
	SEVERITIES,
	VERDICT_MODES,
} from './review-config.constants'

export const severitySchema = Schema.Literals(SEVERITIES)
export type Severity = typeof severitySchema.Type
export const effortSchema = Schema.Literals(EFFORTS)
export type Effort = typeof effortSchema.Type
export const featureModeSchema = Schema.Literals(FEATURE_MODES)
export type FeatureMode = typeof featureModeSchema.Type
export const depthSettingSchema = Schema.Literals(DEPTH_SETTINGS)
export type DepthSetting = typeof depthSettingSchema.Type
/** Globs, labels, authors or branch names. */
export const nameListSchema = Schema.Array(Schema.NonEmptyString)
export const countSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const positiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0))
/** A bot account as GraphQL names it: an app slug, never with `[bot]`. */
export const botSlugSchema = Schema.String.check(
	Schema.isPattern(BOT_SLUG_PATTERN)
)

export const modelSettingSchema = Schema.Struct({
	model: Schema.NonEmptyString,
	effort: effortSchema,
})
export type ModelSetting = typeof modelSettingSchema.Type

/** One or more reviewer models; never empty. */
type ModelList = readonly [ModelSetting, ...ModelSetting[]]

/** One reviewer model or a list, always a list after decoding. */
function toModelList(value: ModelSetting | ModelList): ModelList {
	return 'model' in value ? [value] : value
}

/** A model cannot cross-validate its own findings, so each reviewer model appears once. */
const isDistinctModels = Schema.makeFilter(
	(models: ModelList) =>
		new Set(models.map(entry => entry.model)).size === models.length ||
		'each reviewer model may appear once'
)

/** The first reviewer model finds and the next validates; at deep depth every one finds. */
export const reviewerModelsSchema = Schema.Union([
	modelSettingSchema,
	Schema.NonEmptyArray(modelSettingSchema),
]).pipe(
	Schema.decodeTo(
		Schema.NonEmptyArray(modelSettingSchema).check(isDistinctModels),
		{
			decode: SchemaGetter.transform(toModelList),
			encode: SchemaGetter.transform((models: ModelList) => models),
		}
	)
)

export const commentsSchema = Schema.Struct({
	min_severity: severitySchema,
	max_nits: countSchema,
	summary: Schema.Boolean,
})
export type CommentsSetting = typeof commentsSchema.Type

/** `comments` keys an agent's front matter may override for that agent. */
export const commentsOverrideSchema = commentsSchema.mapFields(fields => ({
	min_severity: Schema.optionalKey(fields.min_severity),
	max_nits: Schema.optionalKey(fields.max_nits),
	summary: Schema.optionalKey(fields.summary),
}))

/** A label name GitHub accepts that is not one the bot must leave alone. */
const riskLabelSchema = Schema.Trim.check(
	Schema.isNonEmpty(),
	Schema.isMaxLength(LABEL_MAX_LENGTH),
	Schema.makeFilter(
		(name: string) =>
			!RESERVED_LABELS.some(label => label === name.toLowerCase()) ||
			`the bot never sets or removes "${name}"`
	)
)

/** One label per level; three different names, so removing one never removes another level's. */
const riskLabelsSchema = Schema.Struct({
	low: riskLabelSchema,
	medium: riskLabelSchema,
	high: riskLabelSchema,
}).check(
	Schema.makeFilter(
		(labels: Readonly<Record<RiskLevel, string>>) =>
			new Set(Object.values(labels).map(name => name.toLowerCase())).size ===
				Object.keys(labels).length || 'each level needs its own label'
	)
)

/** A critical area: changes under `paths` and outside `exclude` rate at least `level`. */
export const riskFloorSchema = Schema.Struct({
	name: Schema.String.check(Schema.isPattern(FLOOR_NAME_PATTERN)),
	paths: Schema.NonEmptyArray(Schema.NonEmptyString),
	exclude: nameListSchema.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
	level: floorLevelSchema.pipe(
		Schema.withDecodingDefault(Effect.succeed(DEFAULT_FLOOR_LEVEL))
	),
})
export type RiskFloor = typeof riskFloorSchema.Type

/** Floor names show in the review body, so each names one floor. */
const isDistinctFloors = Schema.makeFilter(
	(floors: readonly RiskFloor[]) =>
		new Set(floors.map(floor => floor.name)).size === floors.length ||
		'each floor name may appear once'
)

/** The risk rating: off by default, the labels it sets, the floors, the binaries it may leave unread. */
export const riskConfigSchema = Schema.Struct({
	enabled: Schema.Boolean,
	labels: riskLabelsSchema,
	floors: Schema.Array(riskFloorSchema).check(isDistinctFloors),
	/** Binaries the rater may leave unread; any other binary change leaves the pull request unrated. */
	assets: nameListSchema,
	/** `review` commands that rate one head. */
	reviews_per_head: positiveIntSchema,
	/** The rater's model; `validator` rates on the validator's model. */
	model: Schema.Union([
		Schema.Literal(VALIDATOR_RISK_MODEL),
		modelSettingSchema,
	]),
})
export type RiskConfig = typeof riskConfigSchema.Type

/** `review.yml` after merging over its preset; every key is present. */
export const reviewConfigSchema = Schema.Struct({
	extends: Schema.Literal(DEFAULT_PRESET_NAME),
	features: Schema.Struct({
		reviewer: featureModeSchema,
		agents: featureModeSchema,
		verdict: featureModeSchema,
	}),
	depth: depthSettingSchema,
	risk_paths: nameListSchema,
	comments: commentsSchema,
	limits: Schema.Struct({
		max_runs_per_pr: positiveIntSchema,
		max_file_kb: positiveIntSchema,
		tokens_per_run: positiveIntSchema,
		/** Tokens a run plans to spend at each depth; `tokens_per_run` still caps it. */
		tokens_by_depth: Schema.Struct({
			quick: positiveIntSchema,
			balanced: positiveIntSchema,
			deep: positiveIntSchema,
		}),
		tokens_per_pr: positiveIntSchema,
		concurrency: positiveIntSchema,
	}),
	skip: Schema.Struct({
		drafts: Schema.Boolean,
		forks: Schema.Boolean,
		authors: nameListSchema,
		labels: nameListSchema,
		targets: nameListSchema,
		paths: nameListSchema,
	}),
	labels: Schema.Struct({
		always_review: nameListSchema,
		depth: Schema.Struct({
			quick: Schema.NonEmptyString,
			deep: Schema.NonEmptyString,
		}),
	}),
	/** Who may start a review with a mention command besides admins, and how many a pull request gets. */
	commands: Schema.Struct({
		allow: nameListSchema,
		max_runs: positiveIntSchema,
	}),
	disputes: Schema.Struct({
		accept_intentional_up_to: severitySchema,
		max_rounds: countSchema,
	}),
	verdict: Schema.Struct({
		blocking_severity: severitySchema,
		mode: Schema.Literals(VERDICT_MODES),
		never_approve: nameListSchema,
	}),
	models: Schema.Struct({
		router: modelSettingSchema,
		reviewer: reviewerModelsSchema,
		/** Default model for every declared agent. */
		agents: modelSettingSchema,
		validator: Schema.Union([
			Schema.Literal(CROSS_VALIDATOR),
			modelSettingSchema,
		]),
	}),
	/** Bot accounts whose earlier comments still count as the bot's, besides the one posting now. */
	identity: Schema.Struct({ previous: Schema.Array(botSlugSchema) }),
	risk: riskConfigSchema,
})
export type ReviewConfig = typeof reviewConfigSchema.Type
