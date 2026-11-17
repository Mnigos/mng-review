#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { ConfigError } from '../errors.ts'
import { clientFromEnv, envUrl } from '../llm/http.ts'
import type { LlmClient } from '../llm/types.ts'
import { openSession, planSession } from '../session.ts'
import { formatPlanText, planReport } from './format-plan.ts'

const usage = `Usage:
  mng-review plan --base <ref> [options]   show which agents would run and why

Options:
  --base <ref>        base to compare against (required)
  --head <ref>        head commit (default: HEAD)
  --rules-ref <ref>   read .mng/ from this ref (default: the working tree)
  --label <name>      a pull request label; repeat for more
  --author <login>    the pull request author
  --target <branch>   the base branch name (default: derived from --base)
  --no-router         skip the router model call
  --json              print JSON
  -h, --help          show this help

Environment:
  MNG_REVIEW_LLM_URL  OpenAI-compatible base URL, e.g. https://host/v1
  MNG_REVIEW_LLM_KEY  API key for that endpoint`

export interface CliIo {
  cwd: string
  env: Record<string, string | undefined>
  stdout: (text: string) => void
  stderr: (text: string) => void
  /** Overrides the model client, for tests. */
  llm?: LlmClient
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let args: ReturnType<typeof parse>
  try {
    args = parse(argv)
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\n${usage}`)
    return 2
  }
  const { values, positionals } = args
  if (values.help) {
    io.stdout(usage)
    return 0
  }
  const command = positionals[0]
  if (command !== 'plan' || positionals.length > 1) {
    io.stderr(
      `${command ? `unknown command "${positionals.join(' ')}"` : 'missing command'}\n\n${usage}`,
    )
    return 2
  }
  if (!values.base) {
    io.stderr(`--base is required\n\n${usage}`)
    return 2
  }

  try {
    const session = await openSession({
      cwd: io.cwd,
      base: values.base,
      ...(values.head ? { head: values.head } : {}),
      ...(values['rules-ref'] ? { rulesRef: values['rules-ref'] } : {}),
      pr: { labels: values.label ?? [], draft: false, fork: false, trigger: 'manual' },
    })
    if (values.author) session.pr.author = values.author
    const target = values.target ?? (await session.git.branchName(values.base))
    if (target) session.pr.target = target

    let llm: LlmClient | null = null
    let llmUnavailable: string | undefined
    if (values['no-router']) llmUnavailable = 'disabled with --no-router'
    else if (io.llm) llm = io.llm
    else if (!io.env[envUrl]) llmUnavailable = `${envUrl} is not set`
    else llm = clientFromEnv(io.env, { concurrency: session.config.limits.concurrency })

    const plan = await planSession(session, { llm, ...(llmUnavailable ? { llmUnavailable } : {}) })
    const report = planReport(plan, session.change, llm?.tokens.byModel() ?? {})
    io.stdout(values.json ? JSON.stringify(report, null, 2) : formatPlanText(report))
    return 0
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr(`mng-review: ${error.message}`)
      return 2
    }
    throw error
  }
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      base: { type: 'string' },
      head: { type: 'string' },
      'rules-ref': { type: 'string' },
      label: { type: 'string', multiple: true },
      author: { type: 'string' },
      target: { type: 'string' },
      'no-router': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdout: text => process.stdout.write(`${text}\n`),
    stderr: text => process.stderr.write(`${text}\n`),
  })
  process.exit(code)
}
