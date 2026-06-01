// src/app.ts

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createPersistHook } from './admin/persist'
import { createAuthMiddleware } from './auth/middleware'
import { scheduleRefresh } from './auth/scheduler'
import { interpolateEnvVars } from './config/loader'
import { parseConfig } from './config/schema'
import { createProviderRegistry } from './providers/registry'
import { mountAdmin } from './routes/admin'
import { createChatCompletionsRoute } from './routes/chat-completions'
import { createHealthRoute } from './routes/health'
import { createMessagesRoute } from './routes/messages'
import { createModelsRoute } from './routes/models'
import { createRoutingPipeline } from './routing/pipeline'
import { createState, type RouterState } from './state'
import { createConsoleSink, createTelemetryEmitter } from './telemetry/emitter'
import type { RouterOptions, TelemetrySink } from './types'

type Env = { Variables: { requestId: string } }

export type CreateRouterOpts = {
  admin?: { authKey: string }
  persist?: (opts: RouterOptions) => Promise<void>
  telemetrySinks?: TelemetrySink[]
}

export const createRouter = (
  options: RouterOptions,
  opts: CreateRouterOpts = {}
): RouterState & { app: Hono } => {
  if (opts.admin !== undefined && !opts.admin.authKey) {
    throw new Error('createRouter: admin.authKey must be a non-empty string')
  }

  const telemetry = createTelemetryEmitter(opts.telemetrySinks ?? [createConsoleSink()])
  const state = createState(options, opts.persist ?? null, telemetry)

  for (const [providerName, provider] of Object.entries(options.providers)) {
    for (const account of provider.accounts) {
      scheduleRefresh(state, providerName, account)
    }
  }

  const app = new Hono<Env>()
  const startTime = Date.now()
  const registry = createProviderRegistry(state)
  const routing = createRoutingPipeline()

  app.use('*', cors())
  app.use('/v1/*', async (c, next) => {
    const requestId = crypto.randomUUID()
    c.set('requestId', requestId)
    c.header('x-request-id', requestId)
    await next()
  })
  app.use('/v1/*', createAuthMiddleware(options.auth.apiKeys))

  app.get('/', (c) => c.json({ name: 'pi-route', status: 'ok' }))
  app.route('/health', createHealthRoute(registry, startTime))
  app.route('/v1/models', createModelsRoute(options))
  app.route('/v1/messages', createMessagesRoute(registry, routing, state, telemetry))
  app.route('/v1/chat/completions', createChatCompletionsRoute(registry, routing, state, telemetry))

  if (opts.admin !== undefined) {
    mountAdmin(app, state, { authKey: opts.admin.authKey })
  }

  return Object.assign(state, { app: app as unknown as Hono })
}

export const loadRouter = async (
  configPath: string,
  opts: CreateRouterOpts = {}
): Promise<RouterState & { app: Hono }> => {
  const raw: unknown = await Bun.file(configPath).json()
  const options = parseConfig(interpolateEnvVars(raw))
  // File-based persist is the default; caller-provided opts.persist overrides it.
  return createRouter(options, { persist: createPersistHook(configPath), ...opts })
}
