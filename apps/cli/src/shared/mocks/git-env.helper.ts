/** Variables that point git at another repository; set inside a git hook, they would win over `cwd`. */
const GIT_LOCATION_VARIABLES = new Set([
	'GIT_DIR',
	'GIT_WORK_TREE',
	'GIT_COMMON_DIR',
	'GIT_INDEX_FILE',
	'GIT_OBJECT_DIRECTORY',
	'GIT_ALTERNATE_OBJECT_DIRECTORIES',
	'GIT_PREFIX',
])

/** The process environment without git's location variables, so fixtures only touch their own repository. */
export function toFixtureEnv(): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) => !GIT_LOCATION_VARIABLES.has(name)
		)
	)
}
