import { Effect, Layer } from 'effect'
import type {
	RiskCommitStatus,
	TimelineItem,
} from '../../platform/github-risk.schema'
import { GitHubRiskService } from '../../platform/github-risk.service'
import type { GitHubApiError } from '../../platform/github.errors'

/** When a fixture run was created unless `created` says otherwise: after every fixture command. */
const RUN_CREATED = '2026-01-01T12:15:00Z'

/** In-memory timeline and status reads with no HTTP client. */
export function githubRiskFake() {
	const statuses: RiskCommitStatus[] = []
	const timeline: TimelineItem[] = []
	/** Each run's creation time, or the error its read fails with. */
	const created = new Map<number, string | GitHubApiError>()
	const layer = Layer.succeed(GitHubRiskService, {
		listStatuses: () => Effect.succeed([...statuses]),
		createStatus: () => Effect.die('unexpected status write in answer test'),
		listTimeline: () => Effect.succeed([...timeline]),
		readCommentEdits: () =>
			Effect.die('unexpected edit history read in answer test'),
		getRunCreated: runId => {
			const time = created.get(runId) ?? RUN_CREATED
			return typeof time === 'string' ? Effect.succeed(time) : Effect.fail(time)
		},
	})
	return { layer, statuses, timeline, created }
}
