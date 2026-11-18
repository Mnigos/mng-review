/**
 * Every call disables pager, prompts and optional locks; pathspecs are literal, so a path with `*`
 * or `:(` names only itself.
 */
export const GIT_PREFIX = [
	'--literal-pathspecs',
	'-c',
	'core.quotepath=off',
] as const
export const GIT_ENV = {
	GIT_TERMINAL_PROMPT: '0',
	GIT_OPTIONAL_LOCKS: '0',
	GIT_PAGER: 'cat',
} as const satisfies Record<string, string>
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
