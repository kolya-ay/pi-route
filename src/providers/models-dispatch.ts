// src/providers/models-dispatch.ts

import type { Api, Model, Models } from '@earendil-works/pi-ai'
import { ModelsError } from '@earendil-works/pi-ai'

import type { IncomingRequest, Provider, ProviderResponse } from '../types'

import {
  capMaxTokens,
  jsonResponse,
  makeMetadata,
  RETRY_OPTIONS,
  streamingResponse
} from './pi-ai-runtime'
import { toContext } from './to-context'

export class DispatchAuthError extends Error {}

// OAuth-refresh failures surface two ways: a synchronous throw of ModelsError
// code "oauth", or (the common path) an in-stream error event whose message pi-ai
// stamps as "OAuth refresh failed…". Both map to a login-hint 401 at the route.
const isOAuthFailure = (err: unknown): boolean =>
  (err instanceof ModelsError && err.code === 'oauth') ||
  (err instanceof Error && /^OAuth (refresh|auth derivation) failed/.test(err.message))

export const mapAuthError = (err: unknown, providerName: string): unknown =>
  isOAuthFailure(err)
    ? new DispatchAuthError(
        `OAuth for provider "${providerName}" failed to refresh — run \`pi-route login ${providerName}\``
      )
    : err

// openai-compatible providers hold no static catalog (their addresses come from
// pipeline literals), so a request model won't be in getModels(). Construct a
// bare openai-completions Model pointing at the provider's baseUrl — Models still
// routes it to that provider's stream implementation.
const constructModel = (models: Models, providerName: string, id: string): Model<Api> =>
  ({
    id,
    name: id,
    api: 'openai-completions',
    provider: providerName,
    baseUrl: models.getProvider(providerName)?.baseUrl ?? '',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096
  }) as Model<Api>

// One dispatch implementation for every Models-backed provider. Auth is resolved
// inside models.stream() (OAuth refresh under the store lock); the `account`/`apiKey`
// dispatch params are unused here, kept for route-facing Provider signature parity.
// `construct` = true for openai-compatible providers with no catalog entry to look up.
export const createModelsDispatch = (
  models: Models,
  providerName: string,
  construct = false
): Provider => ({
  name: providerName,
  type: 'models',
  async dispatch(request: IncomingRequest): Promise<ProviderResponse> {
    const start = Date.now()
    const body = JSON.parse(await request.rawRequest.text()) as Record<string, unknown>
    const context = toContext(request.format, body)

    const catalogModel =
      models.getModel(providerName, request.model) ??
      (construct ? constructModel(models, providerName, request.model) : undefined)
    if (!catalogModel) throw new Error(`model not found: ${providerName}/${request.model}`)
    const model = capMaxTokens(catalogModel, body)

    // models.stream() resolves auth lazily, so an OAuth refresh failure surfaces
    // as an in-stream error event (mapped in pi-ai-runtime), NOT a sync throw.
    // This catch only covers synchronous setup errors; it stays for completeness.
    let eventStream: ReturnType<typeof models.stream>
    try {
      eventStream = models.stream(model, context, {
        ...RETRY_OPTIONS,
        maxTokens: model.maxTokens,
        signal: request.rawRequest.signal
      })
    } catch (err) {
      throw mapAuthError(err, providerName)
    }

    const metadata = makeMetadata(request, providerName, start)
    const ctx = { costs: { inputCost: model.cost.input, outputCost: model.cost.output } }
    return request.stream
      ? streamingResponse(eventStream, request, metadata, ctx)
      : jsonResponse(eventStream, request, metadata, ctx)
  }
})
