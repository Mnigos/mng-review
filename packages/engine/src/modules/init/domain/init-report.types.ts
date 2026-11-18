import type { AgentKindChoice, InitNote } from '@mng-review/domain'

/** Where the files of `init` come from. */
export type InitSource = 'starter' | 'macroscope'

/** One file `init` wrote, and whether it replaced an existing one. */
export interface WrittenFile {
	readonly path: string
	readonly status: 'created' | 'overwritten'
}

/** What `init` did: the files it wrote, the kind of each imported agent and what it could not carry over. */
export interface InitReport {
	/** The repository root `.mng/` was written in. */
	readonly root: string
	readonly source: InitSource
	readonly files: readonly WrittenFile[]
	readonly agents: readonly AgentKindChoice[]
	readonly notes: readonly InitNote[]
}
