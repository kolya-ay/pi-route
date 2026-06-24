// src/routes/chat-completions.ts

import { Hono } from 'hono'

import type { ProviderEntry } from '../providers/registry'
import type { RouterState } from '../state'
import type { TelemetryEmitter } from '../types'

import { createDispatchHandler } from './dispatch'

export const createChatCompletionsRoute = (
  registry: Map<string, ProviderEntry>,
  state: RouterState,
  telemetry: TelemetryEmitter
): Hono => {
  const app = new Hono()

  app.post('/', createDispatchHandler({ format: 'openai', registry, state, telemetry }))

  return app
}
