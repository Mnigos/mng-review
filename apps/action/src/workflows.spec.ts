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
	test('the sweep job reads pull requests and writes statuses only', () => {
		const sweep = readWorkflow('workflows/status-sweep.yml')
		expect(sweep.slice(0, sweep.indexOf('\njobs:'))).toMatch(
			/^permissions:\n {2}contents: read\n {2}pull-requests: read\n {2}statuses: write\n/mu
		)
		expect(getJob(sweep, 'sweep')).toMatch(
			/permissions:\n\s+contents: read\n\s+pull-requests: read\n\s+statuses: write\n/u
		)
	})
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
				'permission-contents: read',
			],
		],
		[
			'workflows/status-sweep.yml',
			'sweep',
			[
				'permission-statuses: write',
				'permission-pull-requests: read',
				'permission-contents: read',
			],
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

describe('mention command workflow boundaries', () => {
	const command = readWorkflow('workflows/review-command.yml')
	test('authorize holds no secret, checks created and User, and reads with no write permission', () => {
		const authorize = getJob(command, 'authorize')
		expect(authorize).not.toMatch(/\bsecrets\s*[.[]/u)
		expect(authorize).not.toContain('create-github-app-token')
		expect(authorize).not.toContain('llm-')
		expect(authorize).not.toMatch(/^\s+[\w-]+:\s*write\s*$/mu)
		expect(authorize).toContain("github.event_name == 'issue_comment'")
		expect(authorize).toContain("github.event.action == 'created'")
		expect(authorize).toContain("github.event.comment.user.type == 'User'")
		expect(authorize).toContain(
			'!github.event.comment.performed_via_github_app'
		)
		expect(authorize).toContain('MNG_REVIEW_MODE: authorize')
		expect(authorize).not.toContain('github.run_attempt')
	})
	for (const job of ['reserve', 'review', 'publish'])
		test(`${job} requires the first attempt and only review receives endpoint secrets`, () => {
			const block = getJob(command, job)
			expect(block).toMatch(/^ {4}if:.*github\.run_attempt == '1'/mu)
			if (job === 'review') {
				expect(block).toContain('secrets.llm-url')
				expect(block).toContain('secrets.llm-key')
				expect(block).not.toMatch(
					/app-private-key|app-client-id|create-github-app-token/u
				)
				expect(block).not.toMatch(/^\s+[\w-]+:\s*write\s*$/mu)
			} else expect(block).not.toMatch(/llm-|tailscale-oauth/u)
		})
	for (const job of ['reserve', 'publish'])
		test(`${job} serializes summary writes by pull request without cancelling a running writer`, () => {
			const block = getJob(command, job)
			expect(block).toContain(
				'group: mng-review-publish-${{ github.event.issue.number }}'
			)
			expect(block).toContain('cancel-in-progress: false')
			expect(
				getJob(readWorkflow('workflows/review-publish.yml'), 'publish')
			).toContain(
				'group: mng-review-publish-${{ github.event.pull_request.number }}'
			)
		})
	test('reserve mints exactly pull requests write, with automatic revocation', () => {
		const mint = getJob(command, 'reserve')
			.split(/^ {6}- /mu)
			.find(step => step.includes('uses: actions/create-github-app-token@'))
		expect(mint).toBeDefined()
		expect(
			mint
				?.match(/^\s+permission-[\w-]+:\s*\w+/gmu)
				?.map(value => value.trim())
				.toSorted()
		).toEqual(['permission-pull-requests: write'])
		expect(mint).not.toMatch(/^\s*(?:owner|repositories|skip-token-revoke):/mu)
	})
	test('publish uses the same app-token mint and scope as push publishing', () => {
		const commandMint = getJob(command, 'publish')
			.split(/^ {6}- /mu)
			.find(step => step.includes('uses: actions/create-github-app-token@'))
		const pushMint = getJob(
			readWorkflow('workflows/review-publish.yml'),
			'publish'
		)
			.split(/^ {6}- /mu)
			.find(step => step.includes('uses: actions/create-github-app-token@'))
		expect(commandMint).toBeDefined()
		expect(
			commandMint
				?.match(/^\s+permission-[\w-]+:\s*\w+/gmu)
				?.map(value => value.trim())
				.toSorted()
		).toEqual([
			'permission-checks: write',
			'permission-contents: read',
			'permission-pull-requests: write',
			'permission-statuses: write',
		])
		expect(
			commandMint
				?.split('\n')
				.filter(line => !line.trim().startsWith('#') && line.trim())
				.join('\n')
		).toBe(
			pushMint
				?.split('\n')
				.filter(line => !line.trim().startsWith('#') && line.trim())
				.join('\n')
		)
	})
	for (const [path, job] of [
		['workflows/review-command.yml', 'authorize'],
		['workflows/review-command.yml', 'reserve'],
		['workflows/status-sweep.yml', 'sweep'],
	] as const)
		test(`${path} ${job} installs through setup-engine`, () => {
			const block = getJob(readWorkflow(path), job)
			expect(block).toContain(
				'uses: ./.mng-review-engine/.github/actions/setup-engine'
			)
			expect(block).not.toMatch(/oven-sh\/setup-bun|bun install/u)
		})
	test('later jobs take target commits and options from authorization outputs', () => {
		for (const job of ['reserve', 'review', 'publish']) {
			const block = getJob(command, job)
			for (const output of [
				'pull_number',
				'base_sha',
				'head_sha',
				'depth',
				'agent',
			])
				expect(block).toContain(`needs.authorize.outputs.${output}`)
			expect(block).not.toContain('github.event.comment.body')
		}
	})
})

describe('reply schedule workflow boundaries', () => {
	const workflow = readWorkflow('workflows/review-converse.yml')
	test('find has no secret, model configuration or write permission and reads default-branch rules', () => {
		const find = getJob(workflow, 'find')
		expect(find).not.toMatch(/\bsecrets\s*[.[]/u)
		expect(find).not.toMatch(
			/llm-|app-private-key|app-client-id|create-github-app-token/u
		)
		expect(find).not.toMatch(/^\s+[\w-]+:\s*write\s*$/mu)
		expect(find).toContain('MNG_REVIEW_MODE: find')
		expect(find).toContain('ref: ${{ github.event.repository.default_branch }}')
		expect(find).toContain(
			'MNG_REVIEW_MAX_PULL_REQUESTS: ${{ inputs.max-pull-requests }}'
		)
		expect(find).toContain('pulls: ${{ steps.find.outputs.pulls }}')
		expect(find).toContain('lifts: ${{ steps.find.outputs.lifts }}')
	})
	test('lift runs after publish in the publish group with the app key and no endpoint', () => {
		const lift = getJob(workflow, 'lift')
		expect(lift).toContain('needs: [find, publish]')
		expect(lift).toContain(
			"if: ${{ !cancelled() && needs.find.outputs.lifts != '[]' && needs.find.outputs.lifts != '' }}"
		)
		expect(lift).toContain('pull: ${{ fromJSON(needs.find.outputs.lifts) }}')
		expect(lift).toContain('max-parallel: 1')
		expect(lift).toContain(
			'group: mng-review-publish-${{ matrix.pull.number }}'
		)
		expect(lift).toContain('cancel-in-progress: false')
		expect(lift).toContain('MNG_REVIEW_MODE: lift')
		expect(lift).toContain('MNG_REVIEW_TARGET_PR: ${{ matrix.pull.number }}')
		expect(lift).toContain('ref: ${{ github.event.repository.default_branch }}')
		expect(lift).not.toMatch(/llm-|tailscale|statuses:|MNG_REVIEW_TRIGGER/u)
		expect(
			new Set([...lift.matchAll(/secrets\.([\w-]+)/gu)].map(match => match[1]))
		).toEqual(new Set(['app-client-id', 'app-private-key']))
		const mint = lift
			.split(/^ {6}- /mu)
			.find(step => step.includes('uses: actions/create-github-app-token@'))
		expect(
			mint
				?.match(/^\s+permission-[\w-]+:\s*\w+/gmu)
				?.map(line => line.trim())
				.toSorted()
		).toEqual(['permission-contents: read', 'permission-pull-requests: write'])
		expect(lift).toContain("inputs.app-slug == '' && github.token || ''")
		expect(lift).toMatch(
			/permissions:\n\s+contents: read\n\s+pull-requests: write\n/u
		)
	})
	test('the review and publish legs never take the lifts', () => {
		for (const job of ['review', 'publish'])
			expect(getJob(workflow, job)).not.toContain('outputs.lifts')
	})
	test('the inputs, secrets and permissions callers grant are unchanged', () => {
		const header = workflow.slice(0, workflow.indexOf('\njobs:'))
		expect(header).toMatch(
			/^permissions:\n {2}contents: read\n {2}pull-requests: write\n {2}statuses: write\n/mu
		)
		expect(
			[...header.matchAll(/^ {6}([\w-]+):\n {8}description:/gmu)].map(
				match => match[1]
			)
		).toEqual([
			'runner',
			'tailscale',
			'tailscale-tags',
			'timeout-minutes',
			'app-slug',
			'max-pull-requests',
			'llm-url',
			'llm-key',
			'tailscale-oauth-client-id',
			'tailscale-oauth-secret',
			'app-client-id',
			'app-private-key',
		])
	})
	for (const job of ['find', 'review', 'publish'])
		test(`${job} references only its own secrets`, () => {
			const block = getJob(workflow, job)
			const secrets = [...block.matchAll(/secrets\.([\w-]+)/gu)]
				.map(match => match[1] ?? '')
				.toSorted((a, b) => a.localeCompare(b))
			expect([...new Set(secrets)]).toEqual(
				job === 'review'
					? [
							'llm-key',
							'llm-url',
							'tailscale-oauth-client-id',
							'tailscale-oauth-secret',
						]
					: job === 'publish'
						? ['app-client-id', 'app-private-key']
						: []
			)
			if (job !== 'review') expect(block).not.toContain('llm-')
			if (job !== 'publish')
				expect(block).not.toMatch(/app-client-id|app-private-key/u)
		})
	test('publish mints only pull requests write, statuses write and contents read', () => {
		const publish = getJob(workflow, 'publish')
		const mint = publish
			.split(/^ {6}- /mu)
			.find(step => step.includes('uses: actions/create-github-app-token@'))
		expect(mint).toBeDefined()
		expect(
			mint
				?.match(/^\s+permission-[\w-]+:\s*\w+/gmu)
				?.map(line => line.trim())
				.toSorted()
		).toEqual([
			'permission-contents: read',
			'permission-pull-requests: write',
			'permission-statuses: write',
		])
		expect(mint).not.toMatch(/^\s*(?:owner|repositories|skip-token-revoke):/mu)
		expect(publish).not.toMatch(/checks:\s*write|permission-checks/u)
	})
	for (const job of ['review', 'publish'])
		test(`${job} serializes a per-pull matrix with its own artifacts and trusted targets`, () => {
			const block = getJob(workflow, job)
			expect(block).toContain('pull: ${{ fromJSON(needs.find.outputs.pulls) }}')
			expect(block).toContain('max-parallel: 1')
			expect(block).toContain('fail-fast: false')
			expect(block).toContain(
				'outcome-name: mng-review-outcome-${{ matrix.pull.number }}'
			)
			expect(block).toContain(
				'result-name: mng-review-result-${{ matrix.pull.number }}'
			)
			expect(block).toContain('target-pr: ${{ matrix.pull.number }}')
			expect(block).toContain('target-base: ${{ matrix.pull.base }}')
			expect(block).toContain('target-head: ${{ matrix.pull.head }}')
			expect(block).toContain(
				job === 'review' ? 'mode: converse' : 'trigger: converse'
			)
		})
	test('the publish action tolerates a missing outcome only for converse', () => {
		const action = readWorkflow('actions/publish/action.yml')
		const download =
			/^ {4}- name: Download the outcome\n[\s\S]*?(?=^ {4}- name:|$(?![\s\S]))/mu.exec(
				action
			)?.[0]
		expect(download).toContain(
			"continue-on-error: ${{ inputs.trigger == 'converse' }}"
		)
		expect(download).toContain('name: ${{ inputs.outcome-name }}')
	})
	for (const action of ['review', 'publish'])
		test(`${action} takes custom artifact names while preserving the defaults`, () => {
			const text = readWorkflow(`actions/${action}/action.yml`)
			expect(text).toMatch(
				/outcome-name:\n[\s\S]*?default: mng-review-outcome\n/u
			)
			expect(text).toMatch(
				/result-name:\n[\s\S]*?default: mng-review-result\n/u
			)
			expect(text).toContain('name: ${{ inputs.result-name }}')
			expect(text).toContain('name: ${{ inputs.outcome-name }}')
		})
	test('shadow keeps its workflow, mode and result artifact name without an outcome artifact override', () => {
		const shadow = getJob(readWorkflow('workflows/review.yml'), 'review')
		expect(shadow).toContain('name: MNG Review (shadow)')
		expect(shadow).toContain('mode: shadow')
		expect(shadow).toContain(
			'uses: ./.mng-review-engine/.github/actions/review'
		)
		expect(shadow).not.toMatch(
			/outcome-name:|result-name:|MNG_REVIEW_TRIGGER|converse/u
		)
		const action = readWorkflow('actions/review/action.yml')
		expect(action).toContain("if: inputs.mode != 'shadow'")
		expect(action).toContain(
			"MNG_REVIEW_MODE: ${{ inputs.mode == 'shadow' && 'shadow' || 'review' }}"
		)
		expect(action).toContain(
			'MNG_REVIEW_RESULT_PATH: ${{ runner.temp }}/mng-review-result/result.json'
		)
		expect(action).toContain("if: steps.review.outputs.publish == 'true'")
	})
})

describe('reply schedule outcome probe', () => {
	test('checks for the outcome before reading pull request history', () => {
		const publish = getJob(
			readWorkflow('workflows/review-converse.yml'),
			'publish'
		)
		const steps = publish.split(/^ {6}- /mu)
		const probe = steps.find(step =>
			step.startsWith('name: Look for the outcome\n')
		)
		expect(probe).toBeDefined()
		expect(probe).toContain('id: outcome')
		expect(probe).toContain('continue-on-error: true')
		expect(probe).toMatch(/uses: actions\/download-artifact@[a-f\d]{40}/u)
		expect(probe).toContain(
			'name: mng-review-outcome-${{ matrix.pull.number }}'
		)
		const checkout = steps.find(step =>
			step.startsWith('name: Check out the base commit\n')
		)
		const fetch = steps.find(step =>
			step.startsWith('name: Fetch the head commit\n')
		)
		for (const step of [checkout, fetch]) {
			expect(step).toBeDefined()
			expect(step).toContain("if: steps.outcome.outcome == 'success'")
		}
		expect(publish.indexOf('name: Look for the outcome')).toBeLessThan(
			publish.indexOf('name: Check out the base commit')
		)
		expect(publish.indexOf('name: Check out the base commit')).toBeLessThan(
			publish.indexOf('name: Fetch the head commit')
		)
	})
	for (const workflow of ['review-publish', 'review-command'])
		test(`${workflow} still fetches history without a converse outcome probe`, () => {
			const publish = getJob(
				readWorkflow(`workflows/${workflow}.yml`),
				'publish'
			)
			expect(publish).not.toContain('Look for the outcome')
			expect(publish).not.toContain('steps.outcome.outcome')
			expect(publish).toContain('name: Check out the base commit')
			expect(publish).toContain('name: Fetch the head commit')
		})
})
