// src/app.ts

import type { MutableModels } from '@earendil-works/pi-ai'
import { httpInstrumentationMiddleware as otel } from '@hono/otel'
import { bodyLimit } from 'hono/body-limit'
import { contextStorage } from 'hono/context-storage'
import { cors } from 'hono/cors'
import { requestId } from 'hono/request-id'
import { timing } from 'hono/timing'
import { createAuthMiddleware } from './auth/middleware'
import { decompressRequest } from './compression'
import { type EnvPathOverrides, readEnvConfig } from './config/env'
import { loadConfig } from './config/loader'
import { buildModels } from './models/build'
import { buildCatalog, type ModelMeta } from './pipeline/catalog'
import { enrichLiveMeta } from './pipeline/metadata'
import { createModelsDispatch } from './providers/models-dispatch'
import { createPassthroughProvider } from './providers/passthrough'
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
import type { ProviderConfig, ProviderEntry } from './types'

export type CreateAppOpts = {
  admin?: { authKey: string }
}

// Real OpenAI is the only passthrough type with a sensible default base URL;
// other passthrough (arbitrary/unknown) types must supply their own.
const PASSTHROUGH_BASE_URLS: Partial<Record<string, string>> = {
  openai: 'https://api.openai.com/v1'
}

// Build one dispatch entry per configured provider. `openai` and any type the
// Models collection doesn't back forward raw via passthrough; everything else
// dispatches through Models (auth resolved inside models.stream). openai-compatible
// holds no catalog, so its dispatch constructs a model on demand.
const buildEntry = (models: MutableModels, name: string, config: ProviderConfig): ProviderEntry => {
  const backed = models.getProvider(name) !== undefined
  if (config.type === 'openai' || !backed) {
    const baseUrl = config.baseUrl ?? PASSTHROUGH_BASE_URLS[config.type] ?? ''
    if (!baseUrl) throw new Error(`provider "${name}" (type ${config.type}) requires baseUrl`)
    return {
      provider: createPassthroughProvider(name, config.type, baseUrl),
      account: config.account
    }
  }
  const construct = config.type === 'openai-compatible'
  return { provider: createModelsDispatch(models, name, construct), account: config.account }
}

export const createApp = async (
  opts: CreateAppOpts = {},
  envOverrides: EnvPathOverrides = {}
): Promise<RouterState & { app: RouterApp; stop: () => void }> => {
  if (opts.admin !== undefined && !opts.admin.authKey) {
    throw new Error('createApp: admin.authKey must be a non-empty string')
  }

  const env = readEnvConfig(envOverrides)
  const { options, state: runtime } = await loadConfig(env.configPath, env.stateDir)

  // Credential + model stores live under the state dir (the old registry passed
  // env.stateDir as the authDir too).
  // One map, shared: the catalog wrapper writes each provider's lossless parse
  // into it (on the offline restore and on every refresh) and buildCatalog reads
  // it as `liveMeta`, so the payload is fetched and parsed exactly once.
  const liveMeta = new Map<string, ModelMeta>()
  const wrapped = new Set<string>()
  const models = buildModels(options, {
    stateDir: env.stateDir,
    authDir: env.stateDir,
    liveMeta,
    wrapped
  })
  await models.refresh({ allowNetwork: false }) // offline restore of persisted overlays

  const catalog = buildCatalog(options, models, env.stateDir, liveMeta)
  await enrichLiveMeta(options, catalog, wrapped)

  initOtel({ otlpUrl: env.otlpUrl, serviceName: env.serviceName })
  const tel = createTel()
  const state = createState(options, catalog, models, runtime, env.stateDir)

  // Background network refresh, then rebuild the catalog in place so listings and
  // dispatch both see newly-discovered models. Fire once now, then every 4h.
  const refreshAndRebuild = (): Promise<void> =>
    models
      .refresh()
      .then(async () => {
        const next = buildCatalog(options, models, env.stateDir, liveMeta)
        await enrichLiveMeta(options, next, wrapped)
        state.catalog = next
      })
      .catch((err) => console.error(`[models] refresh failed: ${String(err)}`))
  void refreshAndRebuild()
  const timer = setInterval(refreshAndRebuild, 4 * 60 * 60 * 1000)
  timer.unref?.()
  const stop = (): void => clearInterval(timer)

  const registry = new Map<string, ProviderEntry>()
  for (const [name, config] of Object.entries(options.providers)) {
    registry.set(name, buildEntry(models, name, config))
  }

  const app = factory.createApp()
  const startTime = Date.now()

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
  const authMw = createAuthMiddleware(env.authToken ?? state.options.server?.authToken)
  app.use('/v1/*', authMw)
  // Endpoint B aliases outside /v1/* need the same token; /v1/model/info is already covered by /v1/*.
  for (const p of modelInfoPaths) if (!p.startsWith('/v1/')) app.use(p, authMw)

  app.get('/', (c) => c.json({ name: 'pi-route', status: 'ok' }))
  app.route('/health', createHealthRoute(registry, startTime))
  app.route('/v1/models', createModelsRoute(state))
  app.route('/v1/messages', createMessagesRoute(registry))
  app.route('/v1/chat/completions', createChatCompletionsRoute(registry))
  app.route('/v1/limits', createLimitsRoute(state))
  app.route('/v1/responses', createResponsesRoute(registry))

  // Per-request so a post-refresh catalog rebuild is reflected (state read live).
  for (const p of modelInfoPaths) {
    app.get(p, (c) => c.json(buildModelInfoBody(state.options, state.catalog, state.models)))
  }

  const opencode = state.options.server?.opencode
  if (opencode) {
    const apiOverride = opencode.api
    // Public (no authMw): OpenCode fetches /api.json without a bearer token.
    app.get('/api.json', (c) =>
      c.json(
        renderApiJson(
          buildOpencodeModels(state.options, state.catalog, state.models),
          resolveApiUrl(c.req, apiOverride)
        )
      )
    )
  }

  if (opts.admin !== undefined) {
    mountAdmin(app, state, { authKey: opts.admin.authKey })
  }

  return Object.assign(state, { app, stop })
}
