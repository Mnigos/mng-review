import { z } from 'zod'

export const severities = ['low', 'medium', 'high', 'critical'] as const
export const severitySchema = z.enum(severities)
export type Severity = z.infer<typeof severitySchema>

export const efforts = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const
export const effortSchema = z.enum(efforts)
export type Effort = z.infer<typeof effortSchema>

const featureSchema = z.enum(['always', 'manual', 'off'])
export type FeatureMode = z.infer<typeof featureSchema>

export const depthSchema = z.enum(['auto', 'quick', 'balanced', 'deep'])
export type DepthSetting = z.infer<typeof depthSchema>

const globList = z.array(z.string().min(1))
const nameList = z.array(z.string().min(1))

const modelSchema = z.strictObject({
  model: z.string().min(1),
  effort: effortSchema,
})
export type ModelSetting = z.infer<typeof modelSchema>

const commentsSchema = z.strictObject({
  min_severity: severitySchema,
  max_nits: z.int().nonnegative(),
  summary: z.boolean(),
})

const limitsSchema = z.strictObject({
  max_runs_per_pr: z.int().positive(),
  max_file_kb: z.int().positive(),
  tokens_per_run: z.int().positive(),
  tokens_per_pr: z.int().positive(),
  concurrency: z.int().positive(),
})

export const configSchema = z.strictObject({
  extends: z.literal('mng:default'),
  features: z.strictObject({
    reviewer: featureSchema,
    agents: featureSchema,
    verdict: featureSchema,
  }),
  depth: depthSchema,
  risk_paths: globList,
  comments: commentsSchema,
  limits: limitsSchema,
  skip: z.strictObject({
    drafts: z.boolean(),
    forks: z.boolean(),
    authors: nameList,
    labels: nameList,
    targets: nameList,
    paths: globList,
  }),
  labels: z.strictObject({
    always_review: nameList,
    depth: z.strictObject({
      quick: z.string().min(1),
      deep: z.string().min(1),
    }),
  }),
  disputes: z.strictObject({
    accept_intentional_up_to: severitySchema,
    max_rounds: z.int().nonnegative(),
  }),
  verdict: z.strictObject({
    blocking_severity: severitySchema,
    mode: z.enum(['preview', 'approve']),
    never_approve: globList,
  }),
  models: z.strictObject({
    router: modelSchema,
    reviewer: modelSchema,
    nits: modelSchema,
    validator: modelSchema,
    fallback: z.string().min(1).nullable(),
  }),
})

export type Config = z.infer<typeof configSchema>

/** Keys an agent's front matter may override for that agent only. */
export const agentOverrideSchema = z.strictObject({
  comments: commentsSchema.partial().optional(),
})
