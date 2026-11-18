import type { Change, Plan } from '@mng-review/domain'
import type { TokensByModel } from '../../../platform/llm/token-ledger.service'

/** What `mng-review plan` prints: the change, the plan, where the rules came from and the tokens spent. */
export interface PlanReport {
	/** Changed files with the review's skips marked. */
	readonly change: Change
	readonly plan: Plan
	/** `working tree` or the rules ref. */
	readonly rulesSource: string
	readonly tokens: TokensByModel
}
