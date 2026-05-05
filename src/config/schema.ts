import { z } from 'zod'

import type { RouterOptions } from '../types'

const AccountSchema = z
  .object({
    type: z.enum([
      'api-key',
      'claude-cli',
      'anthropic-oauth',
      'copilot-oauth',
      'codex-oauth',
      'antigravity-oauth'
    ]),
    name: z.string()
  })
  .passthrough()

const BalancingSchema = z.object({
  strategy: z.enum(['round-robin', 'sticky', 'fill-first']),
  rateLimitPerModel: z.boolean().optional()
})

const BackendOptionsSchema = z.object({
  type: z.enum(['passthrough-anthropic', 'passthrough-openai', 'pi-ai']),
  baseUrl: z.string(),
  provider: z.string().optional(),
  accounts: z.array(AccountSchema),
  balancing: BalancingSchema
})

const RoutingRuleSchema = z.object({ match: z.string(), backend: z.string() })

const ScenarioEntrySchema = z.object({ backend: z.string(), model: z.string().optional() })

const RouterOptionsSchema = z.object({
  server: z
    .object({ port: z.number().int().positive(), host: z.string() })
    .default({ port: 3000, host: '127.0.0.1' }),
  auth: z.object({ apiKeys: z.array(z.string()) }).default({ apiKeys: [] }),
  backends: z.record(z.string(), BackendOptionsSchema),
  routing: z.object({
    rules: z.array(RoutingRuleSchema).default([]),
    scenarios: z
      .object({
        thinking: ScenarioEntrySchema.optional(),
        'long-context': ScenarioEntrySchema.optional(),
        background: ScenarioEntrySchema.optional()
      })
      .default({}),
    default: z.object({ backend: z.string() })
  }),
  telemetry: z
    .object({ level: z.enum(['debug', 'info', 'warn', 'error']) })
    .default({ level: 'info' })
})

const validateBackendRefs = (opts: z.infer<typeof RouterOptionsSchema>): RouterOptions => {
  const knownBackends = new Set(Object.keys(opts.backends))

  const check = (ref: string, context: string) => {
    if (!knownBackends.has(ref)) {
      throw new Error(`Unknown backend "${ref}" referenced in ${context}`)
    }
  }

  check(opts.routing.default.backend, 'routing.default')

  for (const rule of opts.routing.rules) {
    check(rule.backend, `routing.rules[match=${rule.match}]`)
  }

  for (const [scenario, entry] of Object.entries(opts.routing.scenarios)) {
    if (entry !== undefined) {
      check(entry.backend, `routing.scenarios.${scenario}`)
    }
  }

  return opts as RouterOptions
}

export const parseConfig = (raw: unknown): RouterOptions => {
  const parsed = RouterOptionsSchema.parse(raw)
  return validateBackendRefs(parsed)
}
