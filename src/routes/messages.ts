// src/routes/messages.ts

import { Hono } from 'hono'

import type { ProviderEntry } from '../providers/registry'
import type { RouterState } from '../state'
import type { RoutingStrategy, TelemetryEmitter } from '../types'

import { createDispatchHandler } from './dispatch'

export const createMessagesRoute = (
  registry: Map<string, ProviderEntry>,
  routing: RoutingStrategy,
  state: RouterState,
  telemetry: TelemetryEmitter
): Hono => {
  const app = new Hono()

  app.post('/', createDispatchHandler({ format: 'anthropic', registry, routing, state, telemetry }))

  return app
}
