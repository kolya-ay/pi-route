// src/routes/messages.ts

import { Hono } from 'hono'

import type { ProviderEntry } from '../providers/registry'

import { createDispatchHandler } from './dispatch'

export const createMessagesRoute = (registry: Map<string, ProviderEntry>): Hono => {
  const app = new Hono()
  app.post('/', createDispatchHandler({ format: 'anthropic', registry }))
  return app
}
