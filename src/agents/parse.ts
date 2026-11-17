import { configErrorFromIssues } from '../config/issues.ts'
import { parseYaml } from '../config/load.ts'
import { ConfigError } from '../errors.ts'
import type { RepoReader } from '../repo/reader.ts'
import { type FrontMatter, frontMatterSchema } from './schema.ts'
import { expandImports } from './sections.ts'

export const agentsDir = '.mng/agents'
export const agentNamePattern = /^[a-z0-9][a-z0-9-]*$/
/** Names used by built-in roles; a declared agent cannot take them. */
export const reservedAgentNames = new Set(['reviewer', 'router', 'validator', 'verdict'])

export interface DeclaredAgent {
  /** File name without `.md`. */
  name: string
  file: string
  title: string
  frontMatter: FrontMatter
  /** Instructions with every import expanded. */
  instructions: string
}

/** Splits a Markdown file into its YAML front matter and body. */
export function splitFrontMatter(text: string, source: string): { yaml: string; body: string } {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n?---[ \t]*(?:\n|$)/.exec(normalized)
  if (!match) throw new ConfigError(`${source}: missing YAML front matter between "---" lines`)
  return { yaml: match[1] ?? '', body: normalized.slice(match[0].length) }
}

export function parseFrontMatter(yaml: string, source: string): FrontMatter {
  const raw = parseYaml(yaml, source)
  const result = frontMatterSchema.safeParse(raw ?? {})
  if (!result.success) throw configErrorFromIssues(source, result.error.issues)
  return result.data
}

export async function parseAgent(
  name: string,
  text: string,
  reader: RepoReader,
  file = `${agentsDir}/${name}.md`,
): Promise<DeclaredAgent> {
  if (!agentNamePattern.test(name)) {
    throw new ConfigError(`${file}: agent names use lowercase letters, digits and dashes`)
  }
  if (reservedAgentNames.has(name)) {
    throw new ConfigError(`${file}: "${name}" is reserved for a built-in role`)
  }
  const { yaml, body } = splitFrontMatter(text, file)
  const frontMatter = parseFrontMatter(yaml, file)
  const instructions = (await expandImports(body, reader, file)).trim()
  if (!instructions) throw new ConfigError(`${file}: the agent has no instructions`)
  return { name, file, title: frontMatter.title ?? name, frontMatter, instructions }
}

/** Loads every `.mng/agents/*.md` file. A missing directory means no declared agents. */
export async function loadAgents(reader: RepoReader): Promise<DeclaredAgent[]> {
  const files = (await reader.listFiles(agentsDir)) ?? []
  const agents: DeclaredAgent[] = []
  for (const fileName of files.filter(f => f.endsWith('.md'))) {
    const file = `${agentsDir}/${fileName}`
    const text = await reader.readFile(file)
    if (text === null) continue
    agents.push(await parseAgent(fileName.slice(0, -3), text, reader, file))
  }
  return agents
}
