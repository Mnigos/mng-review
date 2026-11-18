import type {
	ModelTokens,
	TokensByModel,
} from '../../../platform/llm/token-ledger.service'

/** Adds two models' token counts field by field. */
function addTokens(left: ModelTokens, right: ModelTokens): ModelTokens {
	return {
		calls: left.calls + right.calls,
		inputTokens: left.inputTokens + right.inputTokens,
		outputTokens: left.outputTokens + right.outputTokens,
		reasoningTokens: left.reasoningTokens + right.reasoningTokens,
		totalTokens: left.totalTokens + right.totalTokens,
	}
}

/** Tokens per model summed over several runs. */
export function toTokenTotals(runs: readonly TokensByModel[]): TokensByModel {
	const totals: Record<string, ModelTokens> = {}
	for (const tokens of runs)
		for (const [model, entry] of Object.entries(tokens)) {
			const earlier = totals[model]
			totals[model] = earlier ? addTokens(earlier, entry) : entry
		}
	return totals
}
