import type { RiskConfig, RiskLevel } from '@mng-review/domain'
import { Context, Effect, Layer } from 'effect'
import { GitHubApiService } from '../../../platform/github-api.service'
import { GitHubRiskService } from '../../../platform/github-risk.service'
import { OwnedIdentities } from '../../../platform/owned-identities.context'
import {
	getPersonLabels,
	hasSameLabelEvents,
	planRiskLabels,
} from '../domain/risk-label.helper'

/** The pull request whose risk labels a write sets or removes. */
export interface LabelTarget {
	readonly pullNumber: number
	readonly head: string
	readonly labels: RiskConfig['labels']
}

/** The bot's risk label on a pull request: one configured name at a time, never a person's. */
export class RiskLabelService extends Context.Service<
	RiskLabelService,
	{
		/**
		 * Sets `level`'s label, or with none removes the bot's; true when every write passed. Who set
		 * a label is read from a fresh timeline between two reads of the labels, and from a second
		 * timeline read after them, just before the writes, so a person removing the bot's label and
		 * adding it back during the reads counts as the person's. When a read fails, the labels or
		 * their timeline events changed between the reads, or the timeline does not show the head, no
		 * label changes, since a label whose setter is unknown may be a person's. GitHub has no
		 * conditional label delete, so a change between the second timeline read and the writes can
		 * still be lost.
		 */
		readonly sync: (
			target: LabelTarget,
			level: RiskLevel | undefined
		) => Effect.Effect<boolean, never, OwnedIdentities>
	}
>()('mng-review/RiskLabelService') {}

export const RiskLabelServiceLive = Layer.effect(
	RiskLabelService,
	Effect.gen(function* () {
		const api = yield* GitHubApiService
		const risk = yield* GitHubRiskService

		/** The pull request's label names, or `undefined` when the read failed. */
		const readLabels = Effect.fn('RiskLabelService.readLabels')(function* (
			pullNumber: number
		) {
			return yield* api.getPullRequest(pullNumber).pipe(
				Effect.map(pr => pr.labels.map(label => label.name)),
				Effect.orElseSucceed(() => undefined)
			)
		})

		const sync = Effect.fn('RiskLabelService.sync')(function* (
			target: LabelTarget,
			level: RiskLevel | undefined
		) {
			const { identities } = yield* OwnedIdentities
			const current = yield* readLabels(target.pullNumber)
			if (!current) return false
			const items = yield* risk
				.listTimeline(target.pullNumber)
				.pipe(Effect.orElseSucceed(() => undefined))
			if (!items) return false
			const again = yield* readLabels(target.pullNumber)
			if (
				again?.length !== current.length ||
				again.some((name, index) => name !== current[index])
			)
				return false
			const latest = yield* risk
				.listTimeline(target.pullNumber)
				.pipe(Effect.orElseSucceed(() => undefined))
			if (!(latest && hasSameLabelEvents(items, latest))) return false
			const personSet = getPersonLabels(latest, target.head, identities)
			if (!personSet) return false
			const plan = planRiskLabels(
				{ labels: target.labels, current, personSet },
				level
			)
			const removed = yield* Effect.all(
				plan.remove.map(name =>
					api.removeLabel(target.pullNumber, name).pipe(
						Effect.as(true),
						Effect.orElseSucceed(() => false)
					)
				)
			)
			const added = plan.add
				? yield* api.addLabel(target.pullNumber, plan.add).pipe(
						Effect.as(true),
						Effect.orElseSucceed(() => false)
					)
				: true
			return added && removed.every(Boolean)
		})

		return { sync }
	})
)
