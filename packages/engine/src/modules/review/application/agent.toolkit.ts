import { Toolkit } from 'effect/ai'
import { REPO_TOOLS } from './repo.toolkit'
import { ReportFindingsTool } from './report-findings.tool'
import { ReportReplyTool } from './report-reply.tool'
import { ReportRiskTool } from './report-risk.tool'
import { ReportVerdictTool } from './report-verdict.tool'

/** Every tool an agent can be offered; each run picks its own with `toolChoice.oneOf`. */
export const AGENT_TOOLKIT = Toolkit.make(
	...REPO_TOOLS,
	ReportFindingsTool,
	ReportVerdictTool,
	ReportReplyTool,
	ReportRiskTool
)
