import { z } from 'zod'

import type { PipelineEntry, RouterOptions } from '../types'

export const AccountSchema = z.discriminatedUnion('credential', [
  z.object({
    credential: z.literal('key'),
    key: z.string(),
    disabled: z.boolean().optional()
  }),
  z.object({
    credential: z.literal('oauth'),
    name: z.string(),
    projectId: z.string().optional(),
    disabled: z.boolean().optional()
  })
])

const ProviderTypeSchema = z.string()
const ProviderSchema = z.object({
  type: ProviderTypeSchema,
  baseUrl: z.string().optional(),
  account: AccountSchema
})

const StrategySchema = z.enum(['round-robin', 'sticky', 'fill-first', 'failover'])
const MatchSchema = z.enum(['prefix', 'exact'])
const WhenSchema = z.object({ thinking: z.boolean().optional() })

const PipelineEntryObjectSchema = z.object({
  to: z.union([z.string(), z.array(z.string()).nonempty()]),
  match: MatchSchema.optional(),
  strategy: StrategySchema.optional(),
  when: WhenSchema.optional()
})

const PipelineValueSchema = z.union([
  z.string(),
  z.array(z.string()).nonempty(),
  PipelineEntryObjectSchema
])

const RootSchema = z.object({
  providers: z.record(z.string(), ProviderSchema).default({}),
  pipeline: z.record(z.string(), PipelineValueSchema).default({}),
  expose: z.array(z.string()).default([]),
  opencode: z.union([z.boolean(), z.object({ api: z.string().optional() })]).optional()
})

const desugar = (name: string, value: z.infer<typeof PipelineValueSchema>): PipelineEntry => {
  if (typeof value === 'string') {
    return { kind: 'alias', name, target: value }
  }
  if (Array.isArray(value)) {
    return {
      kind: 'pool',
      name,
      to: value,
      strategy: 'round-robin'
    }
  }
  return {
    kind: 'pool',
    name,
    to: Array.isArray(value.to) ? value.to : [value.to],
    strategy: value.strategy ?? 'round-robin',
    ...(value.match !== undefined ? { match: value.match } : {}),
    ...(value.when !== undefined ? { when: value.when } : {})
  }
}

export const parseConfig = (raw: unknown): RouterOptions => {
  const parsed = RootSchema.parse(raw)

  const providerNames = new Set(Object.keys(parsed.providers))
  const pipeline: PipelineEntry[] = []
  for (const [name, value] of Object.entries(parsed.pipeline)) {
    if (providerNames.has(name)) {
      throw new Error(
        `name collision: pipeline entry "${name}" conflicts with provider; rename one`
      )
    }
    pipeline.push(desugar(name, value))
  }

  // exactOptionalPropertyTypes: Zod infers api as `string | undefined`; narrow to `api?: string`.
  const opencode: { api?: string } | undefined =
    parsed.opencode === undefined || parsed.opencode === false
      ? undefined
      : parsed.opencode === true
        ? {}
        : (parsed.opencode as { api?: string })

  return {
    providers: parsed.providers,
    pipeline,
    expose: parsed.expose,
    ...(opencode !== undefined ? { opencode } : {})
  }
}
