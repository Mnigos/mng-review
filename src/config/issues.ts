import type { z } from 'zod'
import { ConfigError } from '../errors.ts'

/** Turns zod issues into one error that names each offending key. */
export function configErrorFromIssues(source: string, issues: z.core.$ZodIssue[]): ConfigError {
  const lines = issues.map(issue => {
    const at = issue.path.map(String).join('.')
    if (issue.code === 'unrecognized_keys') {
      const keys = issue.keys.map(key => (at ? `${at}.${key}` : key))
      return `unknown key${keys.length > 1 ? 's' : ''} ${keys.map(k => `"${k}"`).join(', ')}`
    }
    return `${at ? `"${at}"` : 'value'}: ${issue.message}`
  })
  return new ConfigError(`${source}: ${lines.join('; ')}`)
}
