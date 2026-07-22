import { z } from 'zod'

import type { Account, PipelineEntry, ProviderConfig, RouterOptions } from '../types'

// Config *surface*: apiKey (literal or $VAR) XOR account (oauth). `account` is a
// bare credential-name string, or an object naming it plus an optional projectId.
const AccountValueSchema = z.union([
  z.string(),
  z.strictObject({ name: z.string(), projectId: z.string().optional() })
])

const DiscoverStrategySchema = z.enum([
  'auto',
  'openai-models-list',
  'openai',
  'litellm',
  'guess',
  'fallback'
])

const ModelMetaOverrideSchema = z.strictObject({
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

// openai-compatible endpoints universally serve GET /models with context and
// pricing fields, so discovery is on unless the config opts out.
const OPENAI_LIKE = new Set(['openai-compatible', 'openai'])

const ProviderSchema = z
  .strictObject({
    type: z.string(),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    account: AccountValueSchema.optional(),
    disabled: z.boolean().optional(),
    discover: z.union([z.literal(false), z.array(DiscoverStrategySchema)]).optional(),
    modelOverrides: z.record(z.string(), ModelMetaOverrideSchema).optional()
  })
  .refine((p) => (p.apiKey === undefined) !== (p.account === undefined), {
    message: 'provider requires exactly one of `apiKey` or `account`'
  })
  .refine((p) => !(OPENAI_LIKE.has(p.type) && p.apiKey === undefined), {
    message:
      'openai-compatible/openai providers require an `apiKey`; oauth credentials are not supported for this type (the endpoint catalog can never refresh without a resolvable key)'
  })

type RawProvider = z.infer<typeof ProviderSchema>

// The OAuth credential file is `<type>-<account>.json`. Fold that basename into
// `account.name` at parse time so every reader (resolve, refresh, scheduler, the
// in-memory cache) looks it up consistently — and two providers sharing an account
// value across types (e.g. both `account: main`) resolve to distinct files.
export const credentialName = (type: string, account: string): string => `${type}-${account}`

// Desugar the surface into the internal Account union so all runtime consumers
// (registry, scheduler, resolve, dispatch) keep reading the shape they always have.
const normalizeAccount = (raw: RawProvider): Account => {
  const disabled = raw.disabled !== undefined ? { disabled: raw.disabled } : {}
  if (raw.apiKey !== undefined) {
    return { credential: 'key', key: raw.apiKey, ...disabled }
  }
  const acc = raw.account
  if (typeof acc === 'string') {
    return { credential: 'oauth', name: credentialName(raw.type, acc), ...disabled }
  }
  // acc is defined and an object here (refine guarantees exactly one of apiKey/account).
  const obj = acc as { name: string; projectId?: string }
  return {
    credential: 'oauth',
    name: credentialName(raw.type, obj.name),
    ...(obj.projectId !== undefined ? { projectId: obj.projectId } : {}),
    ...disabled
  }
}

const normalizeDiscover = (raw: RawProvider): ProviderConfig['discover'] =>
  raw.discover !== undefined ? raw.discover : OPENAI_LIKE.has(raw.type) ? ['auto'] : undefined

const normalizeProvider = (raw: RawProvider): ProviderConfig => {
  const discover = normalizeDiscover(raw)
  return {
    type: raw.type,
    ...(raw.baseUrl !== undefined ? { baseUrl: raw.baseUrl } : {}),
    account: normalizeAccount(raw),
    ...(discover !== undefined ? { discover } : {}),
    ...(raw.modelOverrides !== undefined ? { modelOverrides: raw.modelOverrides } : {})
  }
}

const StrategySchema = z.enum(['round-robin', 'sticky', 'fill-first', 'failover'])
const MatchSchema = z.enum(['prefix', 'exact'])
const WhenSchema = z.strictObject({ thinking: z.boolean().optional() })

const PipelineEntryObjectSchema = z.strictObject({
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

const OpencodeSchema = z.union([z.boolean(), z.strictObject({ api: z.string().optional() })])

const ServerSchema = z.strictObject({
  authToken: z.string().optional(),
  opencode: OpencodeSchema.optional()
})

const RootSchema = z.strictObject({
  providers: z.record(z.string(), ProviderSchema).default({}),
  pipeline: z.record(z.string(), PipelineValueSchema).default({}),
  expose: z.array(z.string()).default([]),
  server: ServerSchema.optional()
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

// A top-level key indented one level too deep lands here as a pipeline entry:
// `expose:` under `pipeline:` parses as a pool and silently disables filtering.
const RESERVED_PIPELINE_NAMES = new Set(['expose', 'providers', 'server'])

export const parseConfig = (raw: unknown): RouterOptions => {
  const parsed = RootSchema.parse(raw)

  const providerNames = new Set(Object.keys(parsed.providers))
  const pipeline: PipelineEntry[] = []
  for (const [name, value] of Object.entries(parsed.pipeline)) {
    if (RESERVED_PIPELINE_NAMES.has(name)) {
      throw new Error(
        `pipeline entry "${name}" is a reserved top-level key — de-indent it to the top level`
      )
    }
    if (providerNames.has(name)) {
      throw new Error(
        `name collision: pipeline entry "${name}" conflicts with provider; rename one`
      )
    }
    pipeline.push(desugar(name, value))
  }

  const rawOpencode = parsed.server?.opencode
  // exactOptionalPropertyTypes: Zod infers api as `string | undefined`; narrow to `api?: string`.
  const opencode: { api?: string } | undefined =
    rawOpencode === undefined || rawOpencode === false
      ? undefined
      : rawOpencode === true
        ? {}
        : (rawOpencode as { api?: string })

  const server =
    parsed.server === undefined
      ? undefined
      : {
          ...(parsed.server.authToken !== undefined ? { authToken: parsed.server.authToken } : {}),
          ...(opencode !== undefined ? { opencode } : {})
        }

  return {
    providers: Object.fromEntries(
      Object.entries(parsed.providers).map(([name, raw]) => [name, normalizeProvider(raw)])
    ),
    pipeline,
    expose: parsed.expose,
    ...(server !== undefined && Object.keys(server).length > 0 ? { server } : {})
  }
}
