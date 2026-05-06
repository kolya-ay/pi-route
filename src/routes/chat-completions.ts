// src/routes/chat-completions.ts

import { Hono } from 'hono'

import type { ProviderEntry } from '../providers/registry'
import type { RouterOptions, RoutingStrategy, TelemetryEmitter } from '../types'

import { createDispatchHandler } from './dispatch'

export const createChatCompletionsRoute = (
  registry: Map<string, ProviderEntry>,
  routing: RoutingStrategy,
  options: RouterOptions,
  telemetry: TelemetryEmitter
): Hono => {
  const app = new Hono()

  app.post('/', createDispatchHandler({ format: 'openai', registry, routing, options, telemetry }))

  return app
}
