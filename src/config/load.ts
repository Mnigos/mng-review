import { ConfigError } from '../errors.ts'
import type { RepoReader } from '../repo/reader.ts'
import { configErrorFromIssues } from './issues.ts'
import { deepMerge, isPlainObject } from './merge.ts'
import { presets } from './preset.ts'
import { type Config, configSchema } from './schema.ts'

export const configPath = '.mng/review.yml'

/** Parses `review.yml` text and merges it over its preset. Empty or missing text gives the preset. */
export function parseConfig(text: string | null, source = configPath): Config {
  const raw = text === null ? null : parseYaml(text, source)
  if (raw !== null && !isPlainObject(raw)) {
    throw new ConfigError(`${source}: expected a mapping at the top level`)
  }
  const extendsName = raw?.extends ?? 'mng:default'
  const preset = typeof extendsName === 'string' ? presets[extendsName] : undefined
  if (!preset) {
    throw new ConfigError(
      `${source}: "extends" must be one of ${Object.keys(presets).join(', ')}, got ${JSON.stringify(extendsName)}`,
    )
  }
  const result = configSchema.safeParse(deepMerge(preset, inheritReviewer(raw ?? {}, preset)))
  if (!result.success) throw configErrorFromIssues(source, result.error.issues)
  return result.data
}

/**
 * A single `models.reviewer` object replaces the preset list, so fill its missing keys from the
 * preset's first reviewer, as other partial model entries inherit theirs.
 */
function inheritReviewer(raw: Record<string, unknown>, preset: Config): Record<string, unknown> {
  const models = raw.models
  if (!isPlainObject(models) || !isPlainObject(models.reviewer)) return raw
  const reviewer = deepMerge(preset.models.reviewer[0], models.reviewer)
  return { ...raw, models: { ...models, reviewer } }
}

export async function loadConfig(reader: RepoReader): Promise<Config> {
  return parseConfig(await reader.readFile(configPath), configPath)
}

export function parseYaml(text: string, source: string): unknown {
  try {
    return Bun.YAML.parse(text) ?? null
  } catch (error) {
    throw new ConfigError(`${source}: invalid YAML (${(error as Error).message})`)
  }
}
