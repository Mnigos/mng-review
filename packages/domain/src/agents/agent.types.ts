import type { CommentsSetting, Effort } from '../config/review-config.schema'
import type { AgentFrontMatter } from './agent-front-matter.schema'

/** An agent file split and decoded, before the engine expands its imports. */
export interface AgentFile {
	/** File name without `.md`. */
	readonly name: string
	readonly file: string
	/** `title` from the front matter, or the name. */
	readonly title: string
	readonly frontMatter: AgentFrontMatter
	/** Instructions with import lines not yet expanded. */
	readonly body: string
}

/** A declared agent from `.mng/agents/<name>.md`, its imports expanded. */
export interface DeclaredAgent extends Omit<AgentFile, 'body'> {
	readonly instructions: string
}

/** Model, effort and comment settings one declared agent runs with. */
export interface AgentSettings {
	readonly model: string
	readonly effort: Effort
	readonly comments: CommentsSetting
}

/** An import line: `@/path` imports the whole file, `@/path#Heading` one section of it. */
export interface AgentImport {
	/** Repository-relative and normalised. */
	readonly path: string
	readonly heading?: string
}
