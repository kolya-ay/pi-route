import { z } from 'zod'

import type { Account, PipelineEntry, ProviderConfig, RouterOptions } from '../types'

// Config *surface*: apiKey (literal or $VAR) XOR account (oauth). `account` is a
// bare credential-name string, or an object naming it plus an optional projectId.
const AccountValueSchema = z.union([
  z.string(),
  z.object({ name: z.string(), projectId: z.string().optional() })
])

const DiscoverStrategySchema = z.enum([
  'auto',
  'openai-models-list',
  'openai',
  'litellm',
  'guess',
  'fallback'
])

const ModelMetaOverrideSchema = z.object({
  name: z.string().optional(),
  contextWindow: z.number().optional(),
  maxTokens: z.number().optional(),
  cost: z
    .object({
      input: z.number().optional(),
      output: z.number().optional(),
      cacheRead: z.number().optional(),
      cacheWrite: z.number().optional()
    })
    .optional(),
  reasoning: z.boolean().optional(),
  input: z.array(z.string()).optional()
})

const ProviderSchema = z
  .object({
    type: z.string(),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    account: AccountValueSchema.optional(),
    disabled: z.boolean().optional(),
    discover: z.array(DiscoverStrategySchema).optional(),
    modelOverrides: z.record(z.string(), ModelMetaOverrideSchema).optional()
  })
  .refine((p) => (p.apiKey === undefined) !== (p.account === undefined), {
    message: 'provider requires exactly one of `apiKey` or `account`'
  })

type RawProvider = z.infer<typeof ProviderSchema>

// Desugar the surface into the internal Account union so all runtime consumers
// (registry, scheduler, resolve, dispatch) keep reading the shape they always have.
const normalizeAccount = (raw: RawProvider): Account => {
  const disabled = raw.disabled !== undefined ? { disabled: raw.disabled } : {}
  if (raw.apiKey !== undefined) {
    return { credential: 'key', key: raw.apiKey, ...disabled }
  }
  const acc = raw.account
  if (typeof acc === 'string') {
    return { credential: 'oauth', name: acc, ...disabled }
  }
  // acc is defined and an object here (refine guarantees exactly one of apiKey/account).
  const obj = acc as { name: string; projectId?: string }
  return {
    credential: 'oauth',
    name: obj.name,
    ...(obj.projectId !== undefined ? { projectId: obj.projectId } : {}),
    ...disabled
  }
}

const normalizeProvider = (raw: RawProvider): ProviderConfig => ({
  type: raw.type,
  ...(raw.baseUrl !== undefined ? { baseUrl: raw.baseUrl } : {}),
  account: normalizeAccount(raw),
  ...(raw.discover !== undefined ? { discover: raw.discover } : {}),
  ...(raw.modelOverrides !== undefined ? { modelOverrides: raw.modelOverrides } : {})
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
    providers: Object.fromEntries(
      Object.entries(parsed.providers).map(([name, raw]) => [name, normalizeProvider(raw)])
    ),
    pipeline,
    expose: parsed.expose,
    ...(opencode !== undefined ? { opencode } : {})
  }
}
