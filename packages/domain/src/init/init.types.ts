import type { AgentKind } from '../agents/agent-front-matter.schema'

/** A file `init` writes, its path relative to the repository root. */
export interface RulesFile {
	readonly path: string
	readonly text: string
}

/** `dropped`: not imported; `changed`: imported with another value; `guessed`: chosen by `init`. */
export type InitNoteKind = 'dropped' | 'changed' | 'guessed'

/** One field or file `init` could not carry over as it was. */
export interface InitNote {
	readonly kind: InitNoteKind
	/** The Macroscope file it comes from. */
	readonly source: string
	readonly detail: string
}

/** The kind `init` chose for an imported agent and the words that decided it. */
export interface AgentKindChoice {
	readonly name: string
	readonly kind: AgentKind
	readonly reason: string
}

/** A Macroscope file read from the repository. */
export interface MacroscopeFile {
	readonly path: string
	readonly text: string
}

/** The `.macroscope/` files `init --from-macroscope` reads; any of them may be missing. */
export interface MacroscopeFiles {
	readonly correctness?: MacroscopeFile
	readonly approvability?: MacroscopeFile
	readonly agents: readonly MacroscopeFile[]
}

/** What `init` writes: the files, the kind of each imported agent and what it could not carry over. */
export interface RulesDraft {
	readonly files: readonly RulesFile[]
	readonly agents: readonly AgentKindChoice[]
	readonly notes: readonly InitNote[]
}
