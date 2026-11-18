import { Effect } from 'effect'
import { decodeConfigValue, parseYamlText } from '../config/config-file.parser'
import { ConfigError } from '../config/config.errors'
import {
	type AgentFrontMatter,
	agentFrontMatterSchema,
} from './agent-front-matter.schema'
import {
	AGENT_NAME_PATTERN,
	AGENTS_DIR,
	RESERVED_AGENT_NAMES,
} from './agent.constants'
import type { AgentFile } from './agent.types'

/**
 * Front matter between two `---` lines at the very start of the file. Each `---` stands on its own
 * line; trailing spaces are allowed.
 */
const FRONT_MATTER = /^---[ \t]*\n(?:([\s\S]*?)\n)??---[ \t]*(?:\n|$)/u

/** YAML front matter and the Markdown body after it. */
export interface FrontMatterSplit {
	readonly yaml: string
	readonly body: string
}

/** Splits a Markdown file into its YAML front matter and body. A BOM and CRLF line ends are accepted. */
export function splitFrontMatter(
	text: string,
	source: string
): Effect.Effect<FrontMatterSplit, ConfigError> {
	const normalized = text.replace(/^﻿/u, '').replaceAll('\r\n', '\n')
	const match = FRONT_MATTER.exec(normalized)
	if (!match)
		return Effect.fail(
			new ConfigError({
				source,
				reason: 'missing YAML front matter between "---" lines',
			})
		)
	return Effect.succeed({
		yaml: match[1] ?? '',
		body: normalized.slice(match[0].length),
	})
}

/** Decodes front matter YAML with its defaults; unknown keys fail. */
export function parseFrontMatter(
	yaml: string,
	source: string
): Effect.Effect<AgentFrontMatter, ConfigError> {
	return parseYamlText(yaml, source).pipe(
		Effect.flatMap(raw =>
			decodeConfigValue(agentFrontMatterSchema, raw ?? {}, source)
		)
	)
}

/**
 * Parses `.mng/agents/<name>.md`: checks the name, splits and decodes the front matter. The engine
 * expands the body's imports.
 */
export function parseAgentFile(
	name: string,
	text: string,
	file = `${AGENTS_DIR}/${name}.md`
): Effect.Effect<AgentFile, ConfigError> {
	return Effect.gen(function* () {
		if (!AGENT_NAME_PATTERN.test(name))
			return yield* new ConfigError({
				source: file,
				reason: 'agent names use lowercase letters, digits and dashes',
			})
		if (RESERVED_AGENT_NAMES.some(reserved => reserved === name))
			return yield* new ConfigError({
				source: file,
				reason: `"${name}" is reserved for a built-in role`,
			})
		const { yaml, body } = yield* splitFrontMatter(text, file)
		const frontMatter = yield* parseFrontMatter(yaml, file)
		return { name, file, title: frontMatter.title ?? name, frontMatter, body }
	})
}
