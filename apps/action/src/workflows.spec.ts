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
