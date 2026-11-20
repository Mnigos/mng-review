import { Effect, Layer } from 'effect'
import type { OpenPullRequest } from '../../platform/github-api.schema'
import {
	GitHubStatusService,
	type CheckRunInput,
	type CommitStatusInput,
} from '../../platform/github-status.service'

/** An open pull request of this repository, as the pull request list answers it. */
export function openPullRequest(
	number: number,
	head: string,
	overrides: Partial<OpenPullRequest> = {}
): OpenPullRequest {
	return {
		number,
		base: { sha: 'b'.repeat(40), repo: { full_name: 'owner/repo' } },
		head: { sha: head, repo: { full_name: 'owner/repo' } },
		...overrides,
	}
}

/** In-memory status boundary records requests and allows per-operation failures without HTTP. */
export function githubStatusFake(
	overrides: Partial<GitHubStatusService['Service']> = {}
) {
	const checks: CheckRunInput[] = []
	const statuses: CommitStatusInput[] = []
	const heads: string[] = []
	return {
		checks,
		statuses,
		heads,
		layer: Layer.succeed(GitHubStatusService, {
			createCheckRun: input =>
				Effect.sync(() => {
					checks.push(input)
				}).pipe(
					Effect.andThen(() => overrides.createCheckRun?.(input) ?? Effect.void)
				),
			setStatus: input =>
				Effect.sync(() => {
					statuses.push(input)
				}).pipe(
					Effect.andThen(() => overrides.setStatus?.(input) ?? Effect.void)
				),
			getStatus: head =>
				Effect.sync(() => {
					heads.push(head)
				}).pipe(
					Effect.andThen(
						() => overrides.getStatus?.(head) ?? Effect.succeed(undefined)
					)
				),
			listOpenPullRequests:
				overrides.listOpenPullRequests ?? (() => Effect.succeed([])),
		}),
	}
}
