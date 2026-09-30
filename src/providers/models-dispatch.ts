// src/providers/models-dispatch.ts

import type { Api, Model, Models } from '@earendil-works/pi-ai'
import { ModelsError } from '@earendil-works/pi-ai'
import { trace } from '@opentelemetry/api'

import { perTokenUsd } from '../pipeline/money'
import type {
  FormatTranslationMode,
  IncomingRequest,
  Provider,
  ProviderResponse,
  StructuredOutputApi
} from '../types'

import {
  capMaxTokens,
  type EventTransform,
  jsonResponse,
  makeMetadata,
  RETRY_OPTIONS,
  streamingResponse
} from './pi-ai-runtime'
import { normalizeStructuredOutputEvents, prepareStructuredOutput } from './structured-output'
import { toContext } from './to-context'

export class DispatchAuthError extends Error {}

// The catalog is refreshed from each upstream's own /v1/models, so a miss almost
// always means the provider dropped the model — not a typo in the operator's config.
export class ModelNotOfferedError extends Error {
  constructor(provider: string, model: string) {
    super(
      `${provider} does not offer "${model}" (absent from its model list; check the provider's /v1/models)`
    )
  }
}

// A failure the upstream reported. `status` is the HTTP status when one is known;
// dispatch forwards it to the client only when every failover candidate agrees.
export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

// pi-ai renders an HTTP failure as "<status> status code (…)" and keeps no numeric
// field, so the message is the only place the status survives.
export const upstreamError = (message: string): UpstreamError => {
  const status = /^(\d{3}) status code/.exec(message)?.[1]
  return new UpstreamError(message, status === undefined ? undefined : Number(status))
}

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

// What an openai-compatible endpoint gets when nobody knows better.
const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_MAX_TOKENS = 4096

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
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS
  }) as Model<Api>

// A catalog entry can carry 0 for limits its endpoint never declared (see
// cached-catalog.ts). 0 would cap every request to nothing, so fill it in
// here — after the catalog lookup, before capMaxTokens sees it.
const withKnownLimits = (model: Model<Api>): Model<Api> =>
  model.contextWindow && model.maxTokens
    ? model
    : {
        ...model,
        contextWindow: model.contextWindow || DEFAULT_CONTEXT_WINDOW,
        maxTokens: model.maxTokens || DEFAULT_MAX_TOKENS
      }

// A provider's catalog entry can name an api that cannot carry a schema — OpenRouter
// lists anthropic/* under its anthropic-messages compat endpoint, which refuses
// strict tools. Re-point such a request at the api the provider natively speaks.
// The two groups differ in baseUrl, so the api alone is not enough; the provider's
// own baseUrl is the value the native group already carries. Keeping the catalog
// entry's baseUrl would post a body of one api's shape to the other's path — the
// silent mismatch this swap exists to remove — so a provider that cannot supply one
// refuses instead.
// `compat` and `thinkingLevelMap` describe the api being left behind — `Model.compat`
// is a conditional type on the api, so e.g. OpenRouter's anthropic/claude-opus-4.7
// carries `supportsTemperature: false`, which only the anthropic adapter reads. Carry
// it across and the openai adapter never consults it, then sends a `temperature` the
// model rejects. They belong to the old api, so they are left with it.
const forStructuredOutput = (
  models: Models,
  providerName: string,
  model: Model<Api>,
  api: StructuredOutputApi
): Model<Api> => {
  const baseUrl = models.getProvider(providerName)?.baseUrl
  if (!baseUrl) {
    throw new Error(
      `provider "${providerName}" has no baseUrl to route structured output through ${api}`
    )
  }
  const { compat: _compat, thinkingLevelMap: _thinkingLevelMap, ...carried } = model
  return { ...carried, api, baseUrl }
}

// One dispatch implementation for every Models-backed provider. Auth is resolved
// inside models.stream() (OAuth refresh under the store lock); the `account`/`apiKey`
// dispatch params are unused here, kept for route-facing Provider signature parity.
// `construct` = true for openai-compatible providers with no catalog entry to look up.
export const createModelsDispatch = (
  models: Models,
  providerName: string,
  construct = false,
  formatTranslation: FormatTranslationMode = 'auto',
  structuredOutputApi?: StructuredOutputApi
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
    if (!catalogModel) throw new ModelNotOfferedError(providerName, request.model)
    const routed =
      request.structuredOutput && structuredOutputApi
        ? forStructuredOutput(models, providerName, catalogModel, structuredOutputApi)
        : catalogModel
    const model = capMaxTokens(withKnownLimits(routed), body)

    // Capability resolution throws before streaming, so an unenforceable schema
    // fails this candidate instead of silently producing unconstrained output.
    const plan = request.structuredOutput
      ? prepareStructuredOutput(model, context, request.structuredOutput, formatTranslation)
      : undefined
    const transform: EventTransform | undefined = plan?.normalizeEvents
      ? normalizeStructuredOutputEvents
      : undefined

    // A non-empty list means the enforced schema is weaker than the one requested.
    // The span carries it for anyone collecting telemetry, but OTel is off by default
    // (tel.ts never makes the noop span active, so getActiveSpan() is undefined), and
    // a weakening nobody can see is the thing this reporting exists to prevent — so
    // log it too. That line is the only record in a default deployment.
    if (plan && plan.droppedKeywords.length > 0) {
      const dropped = plan.droppedKeywords.join(', ')
      console.warn(
        `[structured-output] ${providerName}/${request.model}: dropped ${dropped} — ` +
          'this backend cannot enforce those keywords, so the schema is weaker than requested'
      )
      trace
        .getActiveSpan()
        ?.setAttribute('pi.structured_output.dropped_keywords', plan.droppedKeywords)
    }

    // models.stream() resolves auth lazily, so an OAuth refresh failure surfaces
    // as an in-stream error event (mapped in pi-ai-runtime), NOT a sync throw.
    // This catch only covers synchronous setup errors; it stays for completeness.
    let eventStream: ReturnType<typeof models.stream>
    try {
      eventStream = models.stream(model, plan?.context ?? context, {
        ...RETRY_OPTIONS,
        maxTokens: model.maxTokens,
        signal: request.rawRequest.signal,
        ...plan?.options
      })
    } catch (err) {
      throw mapAuthError(err, providerName)
    }

    const metadata = makeMetadata(request, providerName, start)
    // Model.cost is USD per MILLION; perTokenUsd scales it (×1e-6) to the per-token
    // rate the metrics consumer (PerTokenUsd) requires — a dropped conversion is a
    // compile error.
    const ctx = {
      costs: {
        inputCost: perTokenUsd(model.cost.input),
        outputCost: perTokenUsd(model.cost.output)
      }
    }
    return request.stream
      ? streamingResponse(eventStream, request, metadata, ctx, transform)
      : jsonResponse(eventStream, request, metadata, ctx, transform)
  }
})
