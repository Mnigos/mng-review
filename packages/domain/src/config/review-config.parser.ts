import { Effect, Predicate } from 'effect'
import { deepMerge } from '../utils/deep-merge.util'
import { decodeConfigValue, parseYamlText } from './config-file.parser'
import { ConfigError } from './config.errors'
import {
	CONFIG_PATH,
	DEFAULT_PRESET_NAME,
	PRESETS,
} from './review-config.constants'
import { type ReviewConfig, reviewConfigSchema } from './review-config.schema'

/** A parsed YAML mapping. */
type YamlMapping = Readonly<Record<PropertyKey, unknown>>

/** The preset `extends` names, or `undefined` for an unknown name. */
function getPreset(name: unknown): ReviewConfig | undefined {
	return Object.entries(PRESETS).find(([key]) => key === name)?.[1]
}

/**
 * A single `models.reviewer` object replaces the preset list, so it takes its missing keys from the
 * preset's first reviewer, as other partial model entries inherit theirs.
 */
function inheritReviewer(raw: YamlMapping, preset: ReviewConfig): YamlMapping {
	const { models } = raw
	if (!(Predicate.isObject(models) && Predicate.isObject(models.reviewer)))
		return raw
	const reviewer = deepMerge(preset.models.reviewer[0], models.reviewer)
	return { ...raw, models: { ...models, reviewer } }
}

/**
 * Parses `review.yml` text and merges it over the preset it extends. `undefined` (no file), empty
 * text or only comments give the preset.
 */
export function parseReviewConfig(
	text: string | undefined,
	source: string = CONFIG_PATH
): Effect.Effect<ReviewConfig, ConfigError> {
	return Effect.gen(function* () {
		const raw = text === undefined ? null : yield* parseYamlText(text, source)
		if (!(Predicate.isNullish(raw) || Predicate.isObject(raw)))
			return yield* new ConfigError({
				source,
				reason: 'expected a mapping at the top level',
			})
		const mapping = raw ?? {}
		const presetName = mapping.extends ?? DEFAULT_PRESET_NAME
		const preset = getPreset(presetName)
		if (!preset)
			return yield* new ConfigError({
				source,
				reason: `"extends" must be one of ${Object.keys(PRESETS).join(', ')}, got ${JSON.stringify(presetName)}`,
			})
		return yield* decodeConfigValue(
			reviewConfigSchema,
			deepMerge(preset, inheritReviewer(mapping, preset)),
			source
		)
	})
}
