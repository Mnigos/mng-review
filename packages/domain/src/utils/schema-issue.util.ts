import { SchemaIssue } from 'effect'

/** Message the leaf hook gives an unexpected key, so the formatter can name it as unknown. */
const UNKNOWN_KEY_MESSAGE = 'unknown key'

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1({
	leafHook: issue =>
		issue._tag === 'UnexpectedKey'
			? UNKNOWN_KEY_MESSAGE
			: SchemaIssue.defaultLeafHook(issue),
})

/**
 * Formats a schema issue as one clause per problem, each naming its dotted path:
 * `unknown key "comments.max_nit"` or `"limits.concurrency": Expected …`.
 */
export function formatSchemaIssue(issue: SchemaIssue.Issue): string {
	return formatIssue(issue)
		.issues.map(({ path, message }) => {
			const at = (path ?? []).map(String).join('.')
			if (message === UNKNOWN_KEY_MESSAGE) return `unknown key "${at}"`
			return `${at ? `"${at}"` : 'value'}: ${message}`
		})
		.join('; ')
}
