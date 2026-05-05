// src/routes/messages.ts

import { Hono } from 'hono'

import type { BackendEntry } from '../backends/registry.js'
import type { RouterOptions, RoutingStrategy, TelemetryEmitter } from '../types.js'
import { createDispatchHandler } from './dispatch.js'

export const createMessagesRoute = (
  registry: Map<string, BackendEntry>,
  routing: RoutingStrategy,
  options: RouterOptions,
  telemetry: TelemetryEmitter,
): Hono => {
  const app = new Hono()

  app.post('/', createDispatchHandler({ format: 'anthropic', registry, routing, options, telemetry }))

  return app
}
