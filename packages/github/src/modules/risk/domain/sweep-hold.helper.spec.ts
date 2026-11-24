import { Schema } from 'effect'
import { GITHUB_ACTIONS_IDENTITY } from '../../../platform/bot-identity.helper'
import { workflowRunSchema } from '../../../platform/github-risk.schema'
import { threadReply } from '../../../shared/mocks/publish-test.helper'
import {
	getHeadArrival,
	getLatestTime,
	getResolvedHolds,
	isRatedSince,
	isReviewRun,
} from './sweep-hold.helper'

const TIME = '2026-01-01T12:00:00Z'
const LATER = '2026-01-01T12:00:01Z'
const NOW = '2026-01-02T00:00:00Z'
const FUTURE = '2030-01-01T00:00:00Z'
const SCOPE = {
	pullNumber: 17,
	workflow: 'review.yml',
	defaultBranch: 'main',
	repositoryId: 1,
} as const
const RUN = {
	display_title: 'mng-review-risk-17',
	path: '.github/workflows/review.yml',
	event: 'workflow_dispatch',
	head_branch: 'main',
	head_repository: { id: 1 },
} as const

/**
 * A push run of the review workflow as `GET /repos/{owner}/{repo}/actions/runs` lists it. The shape
 * follows the `workflow-run` schema of GitHub's REST API description, whose `pull_requests` items
 * are `pull-request-minimal` objects (`id`, `number`, `url`, and `head` and `base` with `ref`, `sha`
 * and `repo` holding `id`, `url` and `name`); the values are fixtures, not a captured run.
 */
const PUSH_RUN_PAYLOAD = {
	id: 30_433_642,
	name: 'MNG Review',
	node_id: 'WFR_fixture',
	check_suite_id: 42,
	head_branch: 'feature',
	head_sha: 'b'.repeat(40),
	path: '.github/workflows/review.yml@main',
	run_number: 562,
	event: 'pull_request_target',
	display_title: 'Change the store',
	status: 'completed',
	conclusion: 'success',
	workflow_id: 159_038,
	url: 'https://api.example.test/repos/example/project/actions/runs/30433642',
	pull_requests: [
		{
			id: 1,
			number: 17,
			url: 'https://api.example.test/repos/example/project/pulls/17',
			head: {
				ref: 'feature',
				sha: 'b'.repeat(40),
				repo: {
					id: 1,
					url: 'https://api.example.test/repos/example/project',
					name: 'project',
				},
			},
			base: {
				ref: 'main',
				sha: 'a'.repeat(40),
				repo: {
					id: 1,
					url: 'https://api.example.test/repos/example/project',
					name: 'project',
				},
			},
		},
	],
	created_at: '2026-01-02T12:00:00Z',
	updated_at: '2026-01-02T12:05:00Z',
	run_attempt: 1,
	run_started_at: '2026-01-02T12:00:00Z',
	head_repository: { id: 1, name: 'project', full_name: 'example/project' },
	repository: { id: 1, name: 'project', full_name: 'example/project' },
} as const

describe('sweep holds', () => {
	test('takes the latest edit, creation, publication or submission time', () => {
		expect(getLatestTime([undefined, null, TIME, LATER])).toBe(LATER)
		expect(getLatestTime([undefined, null])).toBeUndefined()
	})
	test('a resolved thread holds unnamed replies at or before its resolving answer only', () => {
		const replies = [TIME, LATER].map((at, id) => ({
			id,
			at,
			body: 'confirmed',
			author: 'writer',
		}))
		expect(
			getResolvedHolds(
				[threadReply({ createdAt: TIME })],
				[GITHUB_ACTIONS_IDENTITY],
				replies
			)
		).toEqual([replies[0]])
		expect(getResolvedHolds([], [GITHUB_ACTIONS_IDENTITY], replies)).toEqual([])
	})
	for (const conclusion of ['success', 'failure', 'cancelled', 'skipped', null])
		test(`a later rating job ${conclusion} ${conclusion === 'success' || conclusion === 'failure' ? 'clears' : 'keeps'} the review hold`, () => {
			expect(isRatedSince(TIME, [{ createdAt: LATER, conclusion }])).toBe(
				conclusion === 'success' || conclusion === 'failure'
			)
			expect(isRatedSince(TIME, [{ createdAt: TIME, conclusion }])).toBe(false)
		})
	test('a run counts only from the repository itself', () => {
		expect(isReviewRun(RUN, SCOPE)).toBe(true)
		expect(isReviewRun({ ...RUN, head_repository: { id: 2 } }, SCOPE)).toBe(
			false
		)
		expect(isReviewRun({ ...RUN, head_repository: null }, SCOPE)).toBe(false)
	})
	test('a push run counts from the repository itself too', () => {
		const push = {
			...RUN,
			event: 'pull_request_target',
			display_title: 'Change',
			head_branch: 'feature',
			pull_requests: [{ number: 17, base: { ref: 'main' } }],
		}
		expect(isReviewRun(push, SCOPE)).toBe(true)
		expect(isReviewRun({ ...push, head_repository: { id: 2 } }, SCOPE)).toBe(
			false
		)
	})
	for (const suffix of ['@main', '@refs/heads/main'])
		test(`a run path with its ref ${suffix} counts as the review workflow`, () => {
			expect(
				isReviewRun({ ...RUN, path: `${RUN.path}${suffix}` }, SCOPE)
			).toBeTruthy()
		})
	for (const path of [
		'.github/workflows/review.yml.old@main',
		'.github/workflows/other.yml@main',
		'@.github/workflows/review.yml',
	])
		test(`another workflow file with a ref never counts: ${path}`, () => {
			expect(isReviewRun({ ...RUN, path }, SCOPE)).toBe(false)
		})
	test('a pull_request_target run in the documented workflow run shape counts for its number', () => {
		const run = Schema.decodeUnknownSync(workflowRunSchema)(PUSH_RUN_PAYLOAD)
		expect(isReviewRun(run, SCOPE)).toBe(true)
		expect(isReviewRun(run, { ...SCOPE, pullNumber: 18 })).toBe(false)
		expect(isReviewRun({ ...run, pull_requests: [] }, SCOPE)).toBe(false)
	})
	test('the head arrives no later than the earliest force push that brought it', () => {
		const head = 'b'.repeat(40)
		const brought = {
			__typename: 'HeadRefForcePushedEvent',
			createdAt: TIME,
			beforeCommit: { oid: 'c'.repeat(40) },
			afterCommit: { oid: head },
		} as const
		expect(
			getHeadArrival(
				[
					brought,
					{
						__typename: 'HeadRefForcePushedEvent',
						createdAt: LATER,
						beforeCommit: { oid: head },
						afterCommit: { oid: 'c'.repeat(40) },
					},
					{ ...brought, createdAt: LATER },
				],
				head,
				NOW
			)
		).toBe(TIME)
		expect(
			getHeadArrival(
				[
					brought,
					{
						__typename: 'PullRequestCommit',
						commit: { oid: head, committedDate: FUTURE },
					},
				],
				head,
				NOW
			)
		).toBe(TIME)
		expect(
			getHeadArrival(
				[
					{ ...brought, createdAt: LATER },
					{
						__typename: 'PullRequestCommit',
						commit: { oid: head, committedDate: TIME },
					},
				],
				head,
				NOW
			)
		).toBe(TIME)
	})
	test('the head arrives no later than now', () => {
		const head = 'b'.repeat(40)
		expect(
			getHeadArrival(
				[
					{
						__typename: 'HeadRefForcePushedEvent',
						createdAt: FUTURE,
						beforeCommit: { oid: 'c'.repeat(40) },
						afterCommit: { oid: head },
					},
				],
				head,
				NOW
			)
		).toBe(NOW)
	})
	test('a head only a committer date dates has no arrival, so the runs list from the creation', () => {
		const head = 'b'.repeat(40)
		for (const committedDate of [TIME, FUTURE])
			expect(
				getHeadArrival(
					[
						{
							__typename: 'PullRequestCommit',
							commit: { oid: head, committedDate },
						},
					],
					head,
					NOW
				)
			).toBeUndefined()
		expect(getHeadArrival([], head, NOW)).toBeUndefined()
	})
})
