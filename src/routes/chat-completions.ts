// src/routes/chat-completions.ts

import { Hono } from 'hono'

import type { ProviderEntry } from '../types'

import { createDispatchHandler } from './dispatch'

export const createChatCompletionsRoute = (registry: Map<string, ProviderEntry>): Hono => {
  const app = new Hono()
  app.post('/', createDispatchHandler({ format: 'openai', registry }))
  return app
}
