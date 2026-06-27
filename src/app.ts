// src/app.ts

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createAuthMiddleware } from './auth/middleware'
import { scheduleRefresh } from './auth/scheduler'
import { readEnvConfig } from './config/env'
import { loadConfig } from './config/loader'
import { buildCatalog } from './pipeline/catalog'
import { createProviderRegistry } from './providers/registry'
import { mountAdmin } from './routes/admin'
import { createChatCompletionsRoute } from './routes/chat-completions'
import { createHealthRoute } from './routes/health'
import { createMessagesRoute } from './routes/messages'
import { createModelsRoute } from './routes/models'
import { createResponsesRoute } from './routes/responses'
import { createState, type RouterState } from './state'
import { createConsoleSink, createTelemetryEmitter } from './telemetry/emitter'
import type { TelemetrySink } from './types'

type Env = { Variables: { requestId: string } }

export type CreateAppOpts = {
  admin?: { authKey: string }
  telemetrySinks?: TelemetrySink[]
}

export const createApp = async (opts: CreateAppOpts = {}): Promise<RouterState & { app: Hono }> => {
  if (opts.admin !== undefined && !opts.admin.authKey) {
    throw new Error('createApp: admin.authKey must be a non-empty string')
  }

  const env = readEnvConfig()
  const { options, state: runtime } = await loadConfig(env.configPath, env.authDir)
  const catalog = buildCatalog(options)
  const telemetry = createTelemetryEmitter(opts.telemetrySinks ?? [createConsoleSink()])
  const state = createState(options, catalog, runtime, env.authDir, telemetry)

  for (const [providerName, config] of Object.entries(state.options.providers)) {
    scheduleRefresh(state, providerName, config.account)
  }

  const app = new Hono<Env>()
  const startTime = Date.now()
  const registry = createProviderRegistry(state)

  app.use('*', cors())
  app.use('*', async (c, next) => {
    const encoding = c.req.header('content-encoding')?.toLowerCase()
    if (!encoding || (encoding !== 'zstd' && encoding !== 'gzip' && encoding !== 'deflate'))
      return next()
    const body = c.req.raw.body
    if (!body) return next()
    const decompressed = await new Response(
      body.pipeThrough(new DecompressionStream(encoding as CompressionFormat))
    ).bytes()
    const newHeaders = new Headers(c.req.raw.headers)
    newHeaders.delete('content-encoding')
    newHeaders.delete('content-length')
    c.req.raw = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: newHeaders,
      body: decompressed,
      duplex: 'half'
    } as RequestInit)
    return next()
  })
  app.use('/v1/*', async (c, next) => {
    const requestId = crypto.randomUUID()
    c.set('requestId', requestId)
    c.header('x-request-id', requestId)
    await next()
  })
  app.use('/v1/*', createAuthMiddleware(env.tokens))

  app.get('/', (c) => c.json({ name: 'pi-route', status: 'ok' }))
  app.route('/health', createHealthRoute(registry, startTime))
  app.route('/v1/models', createModelsRoute(state.options, state.catalog))
  app.route('/v1/messages', createMessagesRoute(registry, state, telemetry))
  app.route('/v1/chat/completions', createChatCompletionsRoute(registry, state, telemetry))
  app.route('/v1/responses', createResponsesRoute(registry, state, telemetry))

  if (opts.admin !== undefined) {
    mountAdmin(app, state, { authKey: opts.admin.authKey })
  }

  return Object.assign(state, { app: app as unknown as Hono })
}
