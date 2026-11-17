import type { Change, ChangedFile } from '../change/change.ts'
import type { ModelTokens } from '../llm/types.ts'
import type { Plan, PlannedRun } from '../routing/plan.ts'

export interface PlanReport {
  base: Change['base']
  head: Change['head']
  mergeBase: string
  skipped: string | null
  risk: { level: Plan['risk']; source: Plan['riskSource']; riskPaths: string[] }
  depth: { level: Plan['depth']; source: string }
  router: Plan['router']
  runs: PlannedRun[]
  skips: Plan['skips']
  files: ChangedFile[]
  tokens: Record<string, ModelTokens>
}

export function planReport(plan: Plan, change: Change, tokens: Record<string, ModelTokens>) {
  return {
    base: change.base,
    head: change.head,
    mergeBase: change.mergeBase,
    skipped: plan.skippedRun,
    risk: { level: plan.risk, source: plan.riskSource, riskPaths: plan.riskPathHits },
    depth: { level: plan.depth, source: plan.depthSource },
    router: plan.router,
    runs: plan.runs,
    skips: plan.skips,
    files: plan.files,
    tokens,
  } satisfies PlanReport
}

const short = (sha: string) => sha.slice(0, 8)

export function formatPlanText(report: PlanReport): string {
  const lines: string[] = []
  lines.push(
    `Base ${report.base.ref} (${short(report.base.commit)}), head ${report.head.ref} (${short(report.head.commit)}), merge base ${short(report.mergeBase)}`,
  )
  const skippedFiles = report.files.filter(file => file.skipped)
  lines.push(
    `Changed files: ${report.files.length}${skippedFiles.length ? `, ${skippedFiles.length} left out` : ''}`,
  )
  for (const file of skippedFiles) lines.push(`  - ${file.path} (${fileSkipText(file)})`)
  if (report.skipped) {
    lines.push('', `Run skipped: ${report.skipped}`)
    return lines.join('\n')
  }

  const riskFrom =
    report.risk.source === 'risk_paths'
      ? `risk_paths: ${report.risk.riskPaths.join(', ')}`
      : report.risk.source
  lines.push('', `Risk: ${report.risk.level} (${riskFrom})`)
  lines.push(`Depth: ${report.depth.level} (${report.depth.source})`)
  const router = report.router
  const routerLine =
    router.status === 'ok'
      ? `ok, rated ${router.risk}, added ${router.added.length}`
      : `${router.status}${router.detail ? `: ${router.detail}` : ''}`
  lines.push(`Router: ${routerLine}`)

  lines.push('', `Will run (${report.runs.length}):`)
  if (report.runs.length === 0) lines.push('  (nothing)')
  for (const run of report.runs) {
    const why = run.selectedBy === 'router' ? `router: ${run.reason}` : run.selectedBy
    lines.push(
      `  ${run.name}  ${run.kind}, ${run.input}, ${run.model} ${run.effort}, ${run.files.length} file(s), ${why}`,
    )
  }
  if (report.skips.length > 0) {
    lines.push('', `Skipped (${report.skips.length}):`)
    for (const skip of report.skips) lines.push(`  ${skip.name}  ${skip.reason}`)
  }
  const tokens = Object.entries(report.tokens)
  if (tokens.length > 0) {
    lines.push('', 'Tokens:')
    for (const [model, t] of tokens) {
      lines.push(
        `  ${model}  ${t.totalTokens} (${t.promptTokens} in, ${t.completionTokens} out, ${t.calls} call(s))`,
      )
    }
  }
  return lines.join('\n')
}

function fileSkipText(file: ChangedFile): string {
  if (file.skipped === 'too_large')
    return `over max_file_kb, ${Math.ceil(file.sizeBytes / 1024)} KB`
  return file.skipped ?? ''
}
