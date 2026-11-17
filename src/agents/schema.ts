import { z } from 'zod'
import { agentOverrideSchema, effortSchema } from '../config/schema.ts'

export const agentKinds = ['bug', 'nit'] as const
export const agentInputs = ['incremental', 'full_diff', 'metadata'] as const

const nameList = z.array(z.string().min(1))

export const frontMatterSchema = z.strictObject({
  title: z.string().min(1).optional(),
  kind: z.enum(agentKinds),
  when: z
    .strictObject({
      paths: nameList.default([]),
      exclude: nameList.default([]),
      labels: nameList.default([]),
      authors: nameList.default([]),
      targets: nameList.default([]),
      triage: z.string().trim().min(1).optional(),
    })
    .default({ paths: [], exclude: [], labels: [], authors: [], targets: [] }),
  model: z.string().min(1).optional(),
  effort: effortSchema.optional(),
  input: z.enum(agentInputs).default('incremental'),
  needs: nameList.default([]),
  max_findings: z.int().positive().default(8),
  ...agentOverrideSchema.shape,
})

export type FrontMatter = z.infer<typeof frontMatterSchema>
export type AgentKind = (typeof agentKinds)[number]
export type AgentInput = (typeof agentInputs)[number]
