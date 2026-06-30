// src/routes/responses.ts

import { Hono } from 'hono'

import type { ProviderEntry } from '../providers/registry'

import { createDispatchHandler } from './dispatch'

export const createResponsesRoute = (registry: Map<string, ProviderEntry>): Hono => {
  const app = new Hono()
  app.post('/', createDispatchHandler({ format: 'responses', registry }))
  return app
}
