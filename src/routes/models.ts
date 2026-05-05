// src/routes/models.ts

import { Hono } from 'hono'

import type { RouterOptions } from '../types.js'

export const createModelsRoute = (options: RouterOptions): Hono => {
  const app = new Hono()

  app.get('/', (c) => {
    const data = options.routing.rules
      .map((rule) => rule.match)
      .filter((m) => !m.includes('*'))
      .map((m) => ({
        id: m,
        object: 'model' as const,
        owned_by:
          options.routing.rules.find((r) => r.match === m)?.backend ?? options.routing.default.backend,
      }))

    return c.json({ object: 'list', data })
  })

  return app
}
