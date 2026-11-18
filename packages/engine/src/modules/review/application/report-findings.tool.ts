import { SEVERITIES } from '@mng-review/domain'
import { Schema } from 'effect'
import { Tool } from 'effect/ai'

/**
 * The finding shape the model sees. Answers are decoded leniently by the findings answer parser,
 * not by this schema, so it carries no numeric bounds or string patterns: some providers reject
 * `minimum`, `maximum` and similar keywords in tool schemas.
 */
const findingParametersSchema = Schema.Struct({
	path: Schema.String.annotate({
		description: 'Repository-relative file path.',
	}),
	line: Schema.Number.annotate({
		description: 'Line number at head, a whole number.',
	}),
	severity: Schema.Literals(SEVERITIES),
	title: Schema.String.annotate({
		description: 'One short sentence naming the problem.',
	}),
	trigger: Schema.String.annotate({
		description: 'The input or state that makes it happen.',
	}),
	impact: Schema.String.annotate({
		description: 'What goes wrong for users or data.',
	}),
	evidence: Schema.Array(Schema.String).annotate({
		description: '`path:line` notes.',
	}),
	suggestion: Schema.optionalKey(Schema.String).annotate({
		description: 'A short, self-contained fix.',
	}),
})

/** The finish tool of a finder: every finding of the review at once. */
export const ReportFindingsTool = Tool.make('report_findings', {
	description:
		'Report every finding of this review at once. An empty list means no problems.',
	parameters: Schema.Struct({
		findings: Schema.Array(findingParametersSchema),
	}),
	success: Schema.String,
})
