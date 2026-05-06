// src/app.ts

import { Hono } from 'hono'
import { cors } from 'hono/cors'

import { createAuthMiddleware } from './auth/middleware'
import { createProviderRegistry } from './providers/registry'
import { createChatCompletionsRoute } from './routes/chat-completions'
import { createHealthRoute } from './routes/health'
import { createMessagesRoute } from './routes/messages'
import { createModelsRoute } from './routes/models'
import { createRoutingPipeline } from './routing/pipeline'
import { createConsoleSink, createTelemetryEmitter } from './telemetry/emitter'
import type { RouterOptions } from './types'

type Env = { Variables: { requestId: string } }

export const createApp = (options: RouterOptions) => {
  const app = new Hono<Env>()
  const startTime = Date.now()

  const telemetry = createTelemetryEmitter([createConsoleSink()])
  const registry = createProviderRegistry(options)
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
    createChatCompletionsRoute(registry, routing, options, telemetry)
  )

  return app
}
