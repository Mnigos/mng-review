/**
 * Every call disables pager, prompts and optional locks; pathspecs are literal, so a path with `*`
 * or `:(` names only itself.
 */
export const GIT_PREFIX = [
	'--literal-pathspecs',
	'-c',
	'core.quotepath=off',
] as const
/**
 * Set on every git call: no prompts, no optional locks, no pager. Variables that point git at
 * another repository (set inside a git hook, they would win over the working directory) are
 * removed, so git always reads the repository it was started in.
 */
export const GIT_ENV = {
	GIT_TERMINAL_PROMPT: '0',
	GIT_OPTIONAL_LOCKS: '0',
	GIT_PAGER: 'cat',
	GIT_DIR: undefined,
	GIT_WORK_TREE: undefined,
	GIT_COMMON_DIR: undefined,
	GIT_INDEX_FILE: undefined,
	GIT_OBJECT_DIRECTORY: undefined,
	GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
	GIT_PREFIX: undefined,
} as const satisfies Record<string, string | undefined>
/**
 * Diff options that never run a program from the repository's config, with the `a/` and `b/`
 * prefixes the diff parser reads paths from, whatever `diff.noprefix` says, and submodule updates as
 * patches whatever `diff.submodule` says.
 */
export const SAFE_DIFF = [
	'-M',
	'--no-ext-diff',
	'--no-textconv',
	'--no-color',
	'--src-prefix=a/',
	'--dst-prefix=b/',
	'--submodule=short',
] as const
/** Paths per `ls-tree` call, to stay far below the argument length limit. */
export const PATHS_PER_CALL = 200
/** The tree entry type of a submodule. */
export const GITLINK_TYPE = 'commit'
