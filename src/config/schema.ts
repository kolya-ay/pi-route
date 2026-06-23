import { z } from 'zod'

import type { RouterOptions } from '../types'

const DEFAULT_BASE_URLS: Partial<Record<string, string>> = {
  anthropic: 'https://api.anthropic.com',
  antigravity: 'https://daily-cloudcode-pa.googleapis.com'
}

export const AccountSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('api-key'),
    name: z.string(),
    key: z.string(),
    disabled: z.boolean().optional()
  }),
  z.object({
    type: z.literal('claude-cli'),
    name: z.string(),
    tokenPath: z.string(),
    disabled: z.boolean().optional()
  }),
  z.object({
    type: z.literal('antigravity-oauth'),
    name: z.string(),
    projectId: z.string().optional(),
    disabled: z.boolean().optional()
  }),
  z.object({
    type: z.literal('openai-codex-oauth'),
    name: z.string(),
    disabled: z.boolean().optional()
  })
])

const BalancingSchema = z.object({
  strategy: z.enum(['round-robin', 'sticky', 'fill-first']),
  rateLimitPerModel: z.boolean().optional()
})

const ProviderOptionsSchema = z.object({
  type: z.enum(['anthropic', 'openai', 'antigravity', 'openai-codex']),
  baseUrl: z.string().optional(),
  accounts: z.array(AccountSchema),
  balancing: BalancingSchema
})

const RoutingRuleSchema = z.object({ match: z.string(), provider: z.string() })

const ScenarioEntrySchema = z.object({ provider: z.string(), model: z.string().optional() })

const RouterOptionsSchema = z.object({
  server: z
    .object({ port: z.number().int().positive(), host: z.string() })
    .default({ port: 3000, host: '127.0.0.1' }),
  auth: z.object({ apiKeys: z.array(z.string()) }).default({ apiKeys: [] }),
  providers: z.record(z.string(), ProviderOptionsSchema),
  authDir: z.string().default('~/.config/hono-router/auth'),
  routing: z.object({
    rules: z.array(RoutingRuleSchema).default([]),
    scenarios: z
      .object({
        thinking: ScenarioEntrySchema.optional(),
        'long-context': ScenarioEntrySchema.optional(),
        background: ScenarioEntrySchema.optional()
      })
      .default({}),
    default: z.object({ provider: z.string() })
  }),
  telemetry: z
    .object({ level: z.enum(['debug', 'info', 'warn', 'error']) })
    .default({ level: 'info' })
})

const resolveBaseUrls = (
  opts: z.infer<typeof RouterOptionsSchema>
): z.infer<typeof RouterOptionsSchema> => ({
  ...opts,
  providers: Object.fromEntries(
    Object.entries(opts.providers).map(([name, provider]) => [
      name,
      { ...provider, baseUrl: provider.baseUrl ?? DEFAULT_BASE_URLS[provider.type] }
    ])
  )
})

const validateProviderRefs = (opts: z.infer<typeof RouterOptionsSchema>): RouterOptions => {
  const knownProviders = new Set(Object.keys(opts.providers))

  const check = (ref: string, context: string) => {
    if (!knownProviders.has(ref)) {
      throw new Error(`Unknown provider "${ref}" referenced in ${context}`)
    }
  }

  check(opts.routing.default.provider, 'routing.default')

  for (const rule of opts.routing.rules) {
    check(rule.provider, `routing.rules[match=${rule.match}]`)
  }

  for (const [scenario, entry] of Object.entries(opts.routing.scenarios)) {
    if (entry !== undefined) {
      check(entry.provider, `routing.scenarios.${scenario}`)
    }
  }

  return opts as RouterOptions
}

export const parseConfig = (raw: unknown): RouterOptions => {
  const parsed = RouterOptionsSchema.parse(raw)
  const resolved = resolveBaseUrls(parsed)
  return validateProviderRefs(resolved)
}
