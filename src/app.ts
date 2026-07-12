// src/app.ts

import { httpInstrumentationMiddleware as otel } from '@hono/otel'
import { bodyLimit } from 'hono/body-limit'
import { contextStorage } from 'hono/context-storage'
import { cors } from 'hono/cors'
import { requestId } from 'hono/request-id'
import { timing } from 'hono/timing'

import { createAuthMiddleware } from './auth/middleware'
import { scheduleRefresh } from './auth/scheduler'
import { decompressRequest } from './compression'
import { type EnvPathOverrides, readEnvConfig } from './config/env'
import { loadConfig } from './config/loader'
import { buildCatalog } from './pipeline/catalog'
import { enrichLiveMeta } from './pipeline/metadata'
import { createProviderRegistry } from './providers/registry'
import { mountAdmin } from './routes/admin'
import { buildOpencodeModels, renderApiJson, resolveApiUrl } from './routes/api-json'
import { createChatCompletionsRoute } from './routes/chat-completions'
import { createHealthRoute } from './routes/health'
import { createLimitsRoute } from './routes/limits'
import { createMessagesRoute } from './routes/messages'
import { buildModelInfoBody } from './routes/model-info'
import { createModelsRoute } from './routes/models'
import { createResponsesRoute } from './routes/responses'
import { createState, type RouterState } from './state'
import { factory, type RouterApp } from './telemetry/hono-env'
import { createTel, initOtel } from './telemetry/tel'

export type CreateAppOpts = {
  admin?: { authKey: string }
}

export const createApp = async (
  opts: CreateAppOpts = {},
  envOverrides: EnvPathOverrides = {}
): Promise<RouterState & { app: RouterApp }> => {
  if (opts.admin !== undefined && !opts.admin.authKey) {
    throw new Error('createApp: admin.authKey must be a non-empty string')
  }

  const env = readEnvConfig(envOverrides)
  const { options, state: runtime } = await loadConfig(env.configPath, env.authDir)
  const catalog = buildCatalog(options)
  await enrichLiveMeta(options, catalog)

  initOtel({ otlpUrl: env.otlpUrl, serviceName: env.serviceName })
  const tel = createTel()
  const state = createState(options, catalog, runtime, env.authDir)

  for (const [providerName, config] of Object.entries(state.options.providers)) {
    scheduleRefresh(state, providerName, config.account, tel)
  }

  const app = factory.createApp()
  const startTime = Date.now()
  const registry = createProviderRegistry(state)

  app.use('*', cors())
  app.use('*', decompressRequest({ maxBodyBytes: env.maxBodyBytes }))
  app.use('/v1/*', bodyLimit({ maxSize: env.maxBodyBytes }))
  app.use('/v1/*', requestId())
  app.use('/v1/*', contextStorage())
  app.use('/v1/*', timing())
  app.use('/v1/*', otel())
  app.use(
    '/v1/*',
    factory.createMiddleware(async (c, next) => {
      c.set('tel', tel)
      c.set('state', state)
      await next()
    })
  )
  const modelInfoPaths = ['/model/info', '/v1/model/info', '/v2/model/info', '/model_group/info']
  const authMw = createAuthMiddleware(env.tokens)
  app.use('/v1/*', authMw)
  // Endpoint B aliases outside /v1/* need the same token; /v1/model/info is already covered by /v1/*.
  for (const p of modelInfoPaths) if (!p.startsWith('/v1/')) app.use(p, authMw)

  app.get('/', (c) => c.json({ name: 'pi-route', status: 'ok' }))
  app.route('/health', createHealthRoute(registry, startTime))
  app.route('/v1/models', createModelsRoute(state.options, state.catalog))
  app.route('/v1/messages', createMessagesRoute(registry))
  app.route('/v1/chat/completions', createChatCompletionsRoute(registry))
  app.route('/v1/limits', createLimitsRoute(state, tel))
  app.route('/v1/responses', createResponsesRoute(registry))

  const modelInfoBody = buildModelInfoBody(state.options, state.catalog)
  for (const p of modelInfoPaths) app.get(p, (c) => c.json(modelInfoBody))

  if (state.options.opencode) {
    const opencodeModels = buildOpencodeModels(state.options, state.catalog)
    const apiOverride = state.options.opencode.api
    // Public (no authMw): OpenCode fetches /api.json without a bearer token.
    app.get('/api.json', (c) =>
      c.json(renderApiJson(opencodeModels, resolveApiUrl(c.req, apiOverride)))
    )
  }

  if (opts.admin !== undefined) {
    mountAdmin(app, state, { authKey: opts.admin.authKey })
  }

  return Object.assign(state, { app })
}
