// src/routes/health.ts

import { Hono } from 'hono'

import type { BackendEntry } from '../backends/registry'

export const createHealthRoute = (registry: Map<string, BackendEntry>, startTime: number): Hono => {
  const app = new Hono()

  app.get('/', (c) => {
    const backends: Record<
      string,
      { type: string; accounts: ReturnType<BackendEntry['pool']['health']> }
    > = Object.fromEntries(
      Array.from(registry.entries()).map(([name, entry]) => [
        name,
        { type: entry.backend.type, accounts: entry.pool.health() }
      ])
    )

    return c.json({ status: 'ok', backends, uptime: Math.floor((Date.now() - startTime) / 1000) })
  })

  return app
}
