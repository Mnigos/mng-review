/**
 * Wraps untrusted text (change content, tool output) in a code fence longer than any backtick run
 * inside it, under a label, so the model can tell data from instructions.
 */
export function fenceData(label: string, text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(match => match[0].length))
  const fence = '`'.repeat(longest + 1)
  return `${label}\n${fence}text\n${text}\n${fence}`
}

/** Cuts text to at most `maxChars`, marking the cut. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n[truncated: ${text.length - maxChars} more characters]`
}
