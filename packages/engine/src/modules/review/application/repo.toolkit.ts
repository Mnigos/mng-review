import { Effect, Schema } from 'effect'
import { Tool } from 'effect/ai'

/** `head`: the change; `base`: the merge base it starts from. */
export const TOOL_REFS = ['head', 'base'] as const

const refSchema = Schema.Literals(TOOL_REFS)
	.pipe(Schema.withDecodingDefault(Effect.succeed('head' as const)))
	.annotate({
		description: '`head`: the code after the change; `base`: the merge base.',
	})
const rangeSchema = Schema.optionalKey(Schema.String).annotate({
	description: 'Line range like `40-120`, 1-based and inclusive.',
})
const pathSchema = Schema.String.annotate({
	description: 'Repository-relative path.',
})

export const ReadFileTool = Tool.make('read_file', {
	description:
		'Read a file from the repository at head or base, with line numbers.',
	parameters: Schema.Struct({
		ref: refSchema,
		path: pathSchema,
		range: rangeSchema,
	}),
	success: Schema.String,
})

export const GrepTool = Tool.make('grep', {
	description:
		'Search file contents with an extended regular expression. Returns path:line:text.',
	parameters: Schema.Struct({
		ref: refSchema,
		pattern: Schema.NonEmptyString,
		glob: Schema.optionalKey(Schema.String).annotate({
			description: 'Limit to paths matching this glob, e.g. `src/**/*.ts`.',
		}),
	}),
	success: Schema.String,
})

export const ListDirTool = Tool.make('list_dir', {
	description:
		'List a directory at head or base. Directories end with `/`; `.` is the root.',
	parameters: Schema.Struct({ ref: refSchema, path: pathSchema }),
	success: Schema.String,
})

export const DiffTool = Tool.make('diff', {
	description:
		'Unified diff of the change, for one file or for all reviewable files.',
	parameters: Schema.Struct({ path: Schema.optionalKey(pathSchema) }),
	success: Schema.String,
})

export const BlameTool = Tool.make('blame', {
	description:
		'Who last changed each line of a file at head, with commit and date.',
	parameters: Schema.Struct({
		path: pathSchema,
		range: Schema.String.annotate({
			description: 'Line range like `10-40`, required.',
		}),
	}),
	success: Schema.String,
})

export const PrMetadataTool = Tool.make('pr_metadata', {
	description:
		'Title, description, labels, author, branches, commits and changed files of the change.',
	success: Schema.String,
})

/** Read-only repository tools, in the order the model sees them. */
export const REPO_TOOLS = [
	ReadFileTool,
	GrepTool,
	ListDirTool,
	DiffTool,
	BlameTool,
	PrMetadataTool,
] as const
export type RepoToolName = (typeof REPO_TOOLS)[number]['name']

/** Every repository tool; a validator gets all but `pr_metadata`, a metadata agent only that one. */
export const ALL_REPO_TOOLS = REPO_TOOLS.map(tool => tool.name)
export const VALIDATOR_REPO_TOOLS = ALL_REPO_TOOLS.filter(
	name => name !== PrMetadataTool.name
)
export const METADATA_REPO_TOOLS = [PrMetadataTool.name] as const
