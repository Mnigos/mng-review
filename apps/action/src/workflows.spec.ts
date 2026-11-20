/* oxlint-disable no-template-curly-in-string -- GitHub expressions are intentionally literal workflow text. */
/* oxlint-disable mng-review/file-role-suffix -- The brief explicitly names this workflow-text spec. */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const GITHUB_DIRECTORY = fileURLToPath(
	new URL('../../../.github/', import.meta.url)
)

/** Reads checked-in workflow text, without a YAML library interpreting GitHub expressions. */
function readWorkflow(path: string): string {
	return readFileSync(`${GITHUB_DIRECTORY}/${path}`, 'utf-8')
}

/** The block belonging to one job, stopping before its next sibling job. */
function getJob(text: string, name: string): string {
	const block = new RegExp(
		`^  ${name}:\\n[\\s\\S]*?(?=^  [\\w-]+:|$(?![\\s\\S]))`,
		'mu'
	).exec(text)?.[0]
	expect(block).toBeDefined()
	return block ?? ''
}

describe('workflow credential and permission separation', () => {
	test('the review job requests no write permission', () => {
		const job = getJob(readWorkflow('workflows/review-publish.yml'), 'review')
		expect(job).toContain('permissions:')
		expect(job).not.toMatch(/^\s+[\w-]+:\s*write\s*$/mu)
	})
	test('the publish job names no endpoint or tailnet secret', () => {
		const job = getJob(readWorkflow('workflows/review-publish.yml'), 'publish')
		expect(job).toContain('actions/publish')
		expect(job).not.toMatch(
			/secrets\s*(?:\.[\w-]*(?:llm-|tailscale)|\[\s*['"][\w-]*(?:llm-|tailscale))/iu
		)
		expect(job).not.toMatch(/^\s+(?:llm-[\w-]*|tailscale[\w-]*):/mu)
	})
	test('the composite review step explicitly clears both GitHub token variables', () => {
		const action = readWorkflow('actions/review/action.yml')
		const review =
			/^ {4}- name: Review\n[\s\S]*?(?=^ {4}- name:|$(?![\s\S]))/mu.exec(
				action
			)?.[0]
		expect(review).toBeDefined()
		expect(review).toMatch(/^\s+GITHUB_TOKEN: ''\s*$/mu)
		expect(review).toMatch(/^\s+GH_TOKEN: ''\s*$/mu)
	})
	test('shadow workflow requests no write permission and passes no token to the review action', () => {
		const workflow = readWorkflow('workflows/review.yml')
		expect(workflow).not.toMatch(/^\s+[\w-]+:\s*write\s*$/mu)
		const action = /uses: \.\/[^\n]*actions\/review\n[\s\S]*/u.exec(
			workflow
		)?.[0]
		expect(action).toBeDefined()
		expect(action).not.toMatch(/^\s+token:/mu)
	})
	for (const entry of readdirSync(GITHUB_DIRECTORY, {
		recursive: true,
		withFileTypes: true,
	}).filter(file => file.isFile())) {
		const path = `${entry.parentPath}/${entry.name}`
		test(`${path.slice(GITHUB_DIRECTORY.length)} never forwards all secrets`, () => {
			const text = readFileSync(path, 'utf-8')
			expect(text).not.toMatch(/secrets:\s*inherit/iu)
			expect(text).not.toMatch(/toJSON\s*\(\s*secrets\s*\)/iu)
		})
		if (path.endsWith('.yml') || path.endsWith('.yaml'))
			test(`${path.slice(GITHUB_DIRECTORY.length)} pins every external action to a 40-character SHA`, () => {
				for (const match of readFileSync(path, 'utf-8').matchAll(
					/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gmu
				)) {
					const [, reference] = match
					expect(reference).toBeDefined()
					if (reference?.startsWith('./')) continue
					expect(reference).toMatch(/^[^@]+@[\da-f]{40}$/iu)
				}
			})
	}
})

describe('app credentials stay in writing jobs', () => {
	test('only publish and sweep jobs reference the app secrets', () => {
		const publish = readWorkflow('workflows/review-publish.yml')
		const sweep = readWorkflow('workflows/status-sweep.yml')
		expect(getJob(publish, 'review')).not.toMatch(
			/app-client-id|app-private-key/u
		)
		expect(getJob(publish, 'publish')).toContain('secrets.app-client-id')
		expect(getJob(sweep, 'sweep')).toContain('secrets.app-private-key')
		expect(readWorkflow('workflows/review.yml')).not.toMatch(
			/app-client-id|app-private-key|app-slug/u
		)
		expect(getJob(publish, 'review')).toContain(
			'app-slug: ${{ inputs.app-slug }}'
		)
		expect(getJob(publish, 'review')).not.toContain('create-github-app-token')
	})
	for (const [path, job, permissions] of [
		[
			'workflows/review-publish.yml',
			'publish',
			[
				'permission-pull-requests: write',
				'permission-checks: write',
				'permission-statuses: write',
			],
		],
		[
			'workflows/status-sweep.yml',
			'sweep',
			['permission-statuses: write', 'permission-pull-requests: read'],
		],
	] as const) {
		test(`${job} mints a pinned, scoped, revoked app token after validating credentials`, () => {
			const text = readWorkflow(path)
			const block = getJob(text, job)
			const mints = block
				.split(/^ {6}- /mu)
				.filter(step => /uses: actions\/create-github-app-token@/u.test(step))
			expect(mints).toHaveLength(1)
			for (const mint of mints) {
				expect(mint).toMatch(
					/uses: actions\/create-github-app-token@[a-f\d]{40}(?:\s|$)/iu
				)
				expect(mint).toContain('client-id: ${{ secrets.app-client-id }}')
				expect(mint).toContain('private-key: ${{ secrets.app-private-key }}')
				expect(mint).toContain("if: inputs.app-slug != ''")
				expect(mint).not.toMatch(
					/^\s*(?:owner|repositories|skip-token-revoke|app-id|continue-on-error):/mu
				)
				expect(mint.match(/^\s+permission-[\w-]+:/gmu)).toHaveLength(
					permissions.length
				)
				for (const permission of permissions) expect(mint).toContain(permission)
			}
			expect(block.indexOf('Check the app credentials')).toBeLessThan(
				block.indexOf('Mint the app token')
			)
			expect(block).not.toContain('continue-on-error:')
			expect(text).toMatch(/app-slug:[\s\S]*?default: ''/u)
			expect(text).toMatch(/app-client-id:[\s\S]*?required: false/u)
			expect(text).toMatch(/app-private-key:[\s\S]*?required: false/u)
		})
		test(`${job} never falls back from an app token to the job token`, () => {
			const block = getJob(readWorkflow(path), job)
			for (const expression of block.matchAll(/\$\{\{([\s\S]*?)\}\}/gu))
				expect(expression[1]).not.toMatch(
					/(?:outputs\.token|APP_TOKEN)[\s\S]*\|\|[\s\S]*(?:github\.token|GITHUB_TOKEN)/u
				)
			expect(block).toContain("inputs.app-slug == '' && github.token || ''")
			expect(block).toContain('steps.app.outputs.token')
			expect(block).toContain('steps.app.outputs.app-slug')
		})
	}
	test('the sweep checks out only default-branch rules and passes their checkout directory', () => {
		const block = getJob(readWorkflow('workflows/status-sweep.yml'), 'sweep')
		const checkout = block
			.split(/^ {6}- /mu)
			.find(step => step.startsWith('name: Check out the default branch'))
		expect(checkout).toContain(
			'ref: ${{ github.event.repository.default_branch }}'
		)
		expect(checkout).toContain('path: repo')
		expect(checkout).toContain('fetch-depth: 1')
		expect(checkout).toContain('persist-credentials: false')
		expect(block).toContain('MNG_REVIEW_REPO_DIR:')
	})
	test('the publish action forwards app identity, redacted token and minted slug to the entry', () => {
		const action = readWorkflow('actions/publish/action.yml')
		expect(action).toContain('MNG_REVIEW_APP_SLUG: ${{ inputs.app-slug }}')
		expect(action).toContain('MNG_REVIEW_APP_TOKEN: ${{ inputs.app-token }}')
		expect(action).toContain(
			'MNG_REVIEW_MINTED_APP_SLUG: ${{ inputs.app-token-slug }}'
		)
		expect(action).toContain('GITHUB_TOKEN: ${{ inputs.token }}')
	})
})
