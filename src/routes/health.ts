// src/routes/health.ts

import { Hono } from 'hono'

import type { ProviderEntry } from '../providers/registry'

export const createHealthRoute = (
  registry: Map<string, ProviderEntry>,
  startTime: number
): Hono => {
  const app = new Hono()

  app.get('/', (c) => {
    const providers: Record<
      string,
      { type: string; accounts: ReturnType<ProviderEntry['pool']['health']> }
    > = Object.fromEntries(
      Array.from(registry.entries()).map(([name, entry]) => [
        name,
        { type: entry.provider.type, accounts: entry.pool.health() }
      ])
    )

    return c.json({ status: 'ok', providers, uptime: Math.floor((Date.now() - startTime) / 1000) })
  })

  return app
}
