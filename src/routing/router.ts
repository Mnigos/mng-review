import { z } from 'zod'
import type { ChangedFile } from '../change/change.ts'
import type { ModelSetting } from '../config/schema.ts'
import { fenceData, truncate } from '../llm/fence.ts'
import type { LlmClient, ToolDefinition } from '../llm/types.ts'
import routerPrompt from '../prompts/router.md' with { type: 'text' }
import { type Risk, riskLevels } from './depth.ts'

export interface RouterCandidate {
  name: string
  title: string
  triage: string
}

export interface RouterInput {
  files: ChangedFile[]
  diff: string
  candidates: RouterCandidate[]
}

export interface RouterAddition {
  agent: string
  reason: string
}

export type RouterOutcome =
  | { status: 'ok'; risk: Risk; added: RouterAddition[] }
  | { status: 'failed'; error: string }

export const maxRouterDiffChars = 24_000

const routeTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'route',
    description: 'Report the agents to add and the risk level of the change.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['add', 'risk'],
      properties: {
        add: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['agent', 'reason'],
            properties: { agent: { type: 'string' }, reason: { type: 'string' } },
          },
        },
        risk: { type: 'string', enum: [...riskLevels] },
      },
    },
  },
}

const answerSchema = z.object({
  add: z.array(z.object({ agent: z.string(), reason: z.string() })).default([]),
  risk: z.enum(riskLevels),
})

export function routerMessages(input: RouterInput) {
  const fileList = input.files
    .map(file => {
      const from = file.oldPath ? ` (from ${file.oldPath})` : ''
      return `${file.status} ${file.path}${from} +${file.additions} -${file.deletions}`
    })
    .join('\n')
  const candidates = input.candidates.length
    ? input.candidates.map(c => `- ${c.name} (${c.title}): ${c.triage}`).join('\n')
    : '(none)'
  const user = [
    fenceData('Changed files:', fileList || '(none)'),
    fenceData('Candidate agents:', candidates),
    fenceData('Diff:', truncate(input.diff, maxRouterDiffChars)),
  ].join('\n\n')
  return [
    { role: 'system' as const, content: routerPrompt },
    { role: 'user' as const, content: user },
  ]
}

/**
 * Asks the router model for agents to add and a risk level. Never throws: any failure, including
 * an answer that does not parse, comes back as `failed` so the run can go on with path selection.
 */
export async function runRouter(
  llm: LlmClient,
  model: ModelSetting,
  input: RouterInput,
): Promise<RouterOutcome> {
  try {
    const response = await llm.chat({
      model: model.model,
      effort: model.effort,
      messages: routerMessages(input),
      tools: [routeTool],
      toolChoice: 'required',
    })
    const call = response.toolCalls.find(c => c.function.name === 'route')
    const raw = call ? call.function.arguments : stripFence(response.content ?? '')
    const answer = answerSchema.safeParse(JSON.parse(raw))
    if (!answer.success)
      return { status: 'failed', error: 'router answer did not match the schema' }
    return { status: 'ok', risk: answer.data.risk, added: keepValid(answer.data.add, input) }
  } catch (error) {
    return { status: 'failed', error: (error as Error).message }
  }
}

/** Drops unknown or repeated agents and additions without a reason. */
function keepValid(add: RouterAddition[], input: RouterInput): RouterAddition[] {
  const names = new Set(input.candidates.map(c => c.name))
  const seen = new Set<string>()
  const result: RouterAddition[] = []
  for (const { agent, reason } of add) {
    const trimmed = reason.trim()
    if (!names.has(agent) || seen.has(agent) || !trimmed) continue
    seen.add(agent)
    result.push({ agent, reason: trimmed })
  }
  return result
}

function stripFence(text: string): string {
  const match = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  return (match?.[1] ?? text).trim()
}
