import { execFileSync } from 'node:child_process'
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
	NodeChildProcessSpawner,
	NodeFileSystem,
	NodePath,
} from '@effect/platform-node-shared'
import { GitServiceLive, GitWorkdir } from '@mng-review/engine'
import { Layer } from 'effect'

const roots: string[] = []
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
function toFixtureEnv(): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) => !GIT_LOCATION_VARIABLES.has(name)
		)
	)
}
const NodeLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
const ProcessLayer = NodeChildProcessSpawner.layer.pipe(
	Layer.provide(NodeLayer)
)

/** Creates an isolated repository; all fixture commands disable hooks and signing. */
export function createRepo(name = 'repo') {
	const parent = realpathSync(mkdtempSync(join(tmpdir(), 'mng-review-spec-')))
	roots.push(parent)
	const root = join(parent, name)
	mkdirSync(root)
	const git = (...args: string[]) =>
		execFileSync(
			'git',
			[
				'-c',
				'user.name=Author',
				'-c',
				'user.email=author@example.test',
				'-c',
				'commit.gpgsign=false',
				'-c',
				'core.hooksPath=/dev/null',
				...args,
			],
			{
				cwd: root,
				encoding: 'utf-8',
				env: {
					...toFixtureEnv(),
					GIT_CONFIG_GLOBAL: '/dev/null',
					GIT_CONFIG_NOSYSTEM: '1',
					GIT_TERMINAL_PROMPT: '0',
				},
			}
		).trimEnd()
	const write = (path: string, text: string | Uint8Array) => {
		const full = join(root, path)
		mkdirSync(dirname(full), { recursive: true })
		writeFileSync(full, text)
	}
	const commit = () => {
		git('add', '--all')
		git('commit', '-m', 'fixture')
		return git('rev-parse', 'HEAD')
	}
	git('init', '--initial-branch=main')
	return { root, git, write, commit }
}

/** Removes only repositories allocated by this fixture module. */
export function cleanupRepos() {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true })
}
/** Reads fixture repositories through the real local git service. */
export function gitLayer(root: string) {
	return GitServiceLive.pipe(
		Layer.provide(ProcessLayer),
		Layer.provide(Layer.succeed(GitWorkdir, { cwd: root }))
	)
}
export const FileSystemLayer = NodeLayer
