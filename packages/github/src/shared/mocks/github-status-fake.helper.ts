import { Effect, Layer } from 'effect'
import {
	GitHubStatusService,
	type CheckRunInput,
	type CommitStatusInput,
} from '../../platform/github-status.service'

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
