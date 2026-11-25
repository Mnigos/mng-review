import type { DismissalOutcome } from '../../publish/domain/publish.types'
import type { ReviewDecision } from '../../publish/domain/review-event.helper'
import type {
	LiftResult,
	RaiseJudgment,
	RaiseOutcome,
	StatusWrite,
} from './raise.service.types'

/** A raise's outcome once it tried its writes: only a write that landed raises. */
export const getWriteOutcome = (
	written: StatusWrite,
	lifted: LiftResult
): RaiseOutcome => {
	if (written.status?.state === 'success' || lifted.dismissal.dismissed > 0)
		return 'raised'
	if (written.status) return 'updated'
	if (written.statusError !== undefined || lifted.dismissal.failed > 0)
		return 'refused'
	return lifted.gate === 'closed' ? 'closed' : 'moved'
}

/** Nothing dismissed. */
export const NO_DISMISSAL = {
	dismissed: 0,
	failed: 0,
} as const satisfies DismissalOutcome

/** A write that clears, as `getStaleChangeRequests` takes it: every owned change request is stale. */
export const CLEARING = {
	event: 'COMMENT',
	clears: true,
} as const satisfies Pick<ReviewDecision, 'event' | 'clears'>

/** True when a judgment writes anything: a raise, or a status that changed. */
export function isDue(judgment: RaiseJudgment): boolean {
	return judgment.status !== undefined || judgment.stale.length > 0
}
