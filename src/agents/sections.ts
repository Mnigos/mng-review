import { ConfigError } from '../errors.ts'
import { normalizeRepoPath } from '../repo/paths.ts'
import type { RepoReader } from '../repo/reader.ts'

/** A line that is only `@/path` or `@/path#Heading`. */
const importLine = /^@\/([^\s#][^#]*?)(?:#(.+))?$/

/**
 * Replaces every import line in `body` with the file or section it names, read through `reader`.
 * Imported text is inserted as is; imports inside it are not expanded.
 */
export async function expandImports(
  body: string,
  reader: RepoReader,
  source: string,
): Promise<string> {
  const lines = body.split('\n')
  const out: string[] = []
  for (const line of lines) {
    const match = importLine.exec(line.trim())
    if (!match) {
      out.push(line)
      continue
    }
    const [, rawPath = '', heading] = match
    const path = normalizeRepoPath(rawPath.trim())
    if (path === null || path === '.') {
      throw new ConfigError(`${source}: import "${line.trim()}" points outside the repository`)
    }
    const text = await reader.readFile(path)
    if (text === null) {
      throw new ConfigError(
        `${source}: import "${line.trim()}": ${path} not found in ${reader.source}`,
      )
    }
    if (heading === undefined) {
      out.push(text.trimEnd())
      continue
    }
    const section = extractSection(text, heading.trim())
    if (section === null) {
      throw new ConfigError(
        `${source}: import "${line.trim()}": no heading "${heading.trim()}" in ${path}`,
      )
    }
    out.push(section)
  }
  return out.join('\n')
}

const headingLine = /^(#{1,6})\s+(.*?)\s*#*\s*$/

/**
 * Returns the section that starts at the Markdown heading with the given text and ends before the
 * next heading of the same or a higher level. Headings inside fenced code blocks are ignored.
 */
export function extractSection(markdown: string, heading: string): string | null {
  const lines = markdown.split('\n')
  let start = -1
  let level = 0
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1]
      if (fence === null) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
      continue
    }
    if (fence !== null) continue
    const match = headingLine.exec(line)
    if (!match?.[1]) continue
    const thisLevel = match[1].length
    if (start === -1) {
      if (match[2] === heading) {
        start = i
        level = thisLevel
      }
    } else if (thisLevel <= level) {
      return lines.slice(start, i).join('\n').trimEnd()
    }
  }
  return start === -1 ? null : lines.slice(start).join('\n').trimEnd()
}
