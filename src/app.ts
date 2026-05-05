// src/app.ts

import { Hono } from 'hono'
import { cors } from 'hono/cors'

import { createAuthMiddleware } from './auth/middleware.js'
import { createBackendRegistry } from './backends/registry.js'
import { createRoutingPipeline } from './routing/pipeline.js'
import { createChatCompletionsRoute } from './routes/chat-completions.js'
import { createHealthRoute } from './routes/health.js'
import { createMessagesRoute } from './routes/messages.js'
import { createModelsRoute } from './routes/models.js'
import { createConsoleSink, createTelemetryEmitter } from './telemetry/emitter.js'
import type { RouterOptions } from './types.js'

type Env = { Variables: { requestId: string } }

export const createApp = (options: RouterOptions) => {
  const app = new Hono<Env>()
  const startTime = Date.now()

  const telemetry = createTelemetryEmitter([createConsoleSink()])
  const registry = createBackendRegistry(options)
  const routing = createRoutingPipeline()

  // Middleware
  app.use('*', cors())
  app.use('/v1/*', async (c, next) => {
    c.set('requestId', crypto.randomUUID())
    c.header('x-request-id', c.get('requestId') as string)
    await next()
  })
  app.use('/v1/*', createAuthMiddleware(options.auth.apiKeys))

  // Routes
  app.get('/', (c) => c.json({ name: 'hono-router', status: 'ok' }))
  app.route('/health', createHealthRoute(registry, startTime))
  app.route('/v1/models', createModelsRoute(options))
  app.route('/v1/messages', createMessagesRoute(registry, routing, options, telemetry))
  app.route(
    '/v1/chat/completions',
    createChatCompletionsRoute(registry, routing, options, telemetry),
  )

  return app
}
