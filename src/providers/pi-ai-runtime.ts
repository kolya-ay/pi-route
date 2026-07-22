// src/providers/pi-ai-runtime.ts

import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream
} from '@earendil-works/pi-ai'

import type { PerTokenUsd } from '../pipeline/money'
import { wrapStreamForMetrics } from '../telemetry/stream-metrics'
import type { IncomingRequest, ProviderResponse } from '../types'

import { mapAuthError } from './models-dispatch'
import { formatJson, formatSse } from './to-sse'

// Self-heal transient 429/5xx via pi-ai's SDK-level retry. 3 attempts caps
// Codex's `usage_limit_reached` retry storm; 30s caps the per-attempt wait
// before we surface the error to the client.
export const RETRY_OPTIONS = { maxRetries: 3, maxRetryDelayMs: 30_000 } as const

export const capMaxTokens = <M extends { maxTokens: number }>(
  model: M,
  body: Record<string, unknown>
): M => {
  const requested = body.max_tokens ?? body.max_output_tokens
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) return model
  return { ...model, maxTokens: Math.min(requested, model.maxTokens) }
}

export const makeMetadata = (
  request: IncomingRequest,
  providerName: string,
  startMs: number
): ProviderResponse['metadata'] => ({
  requestId: request.id,
  provider: providerName,
  model: request.model,
  latencyMs: Date.now() - startMs
})

// Costs are per-TOKEN rates (PerTokenUsd). The pi-ai catalog Model prices per
// million, so the dispatch site converts via perTokenUsd(perMillionUsd(...)) —
// the brand makes a dropped conversion a compile error.
export type StreamMetricsCtx = {
  costs: { inputCost: PerTokenUsd; outputCost: PerTokenUsd }
}

const wrapIfTelHooks = (
  eventStream: AssistantMessageEventStream,
  request: IncomingRequest,
  ctx: StreamMetricsCtx
): AsyncIterable<AssistantMessageEvent> => {
  if (request.telHooks === undefined) return eventStream
  const { tel, span, capture } = request.telHooks
  return wrapStreamForMetrics(eventStream, span, tel, ctx.costs, capture)
}

export const streamingResponse = (
  eventStream: AssistantMessageEventStream,
  request: IncomingRequest,
  metadata: ProviderResponse['metadata'],
  ctx: StreamMetricsCtx
): ProviderResponse => {
  const events = wrapIfTelHooks(eventStream, request, ctx)
  return {
    status: 200,
    headers: new Headers({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    }),
    body: formatSse(request.format, events, request.id, request.model),
    metadata
  }
}

// Collect-and-serialize for non-streaming. Throws on mid-stream error so the
// dispatch.ts catch-wrapper can surface a 502 + provider_error telemetry.
export const jsonResponse = async (
  eventStream: AssistantMessageEventStream,
  request: IncomingRequest,
  metadata: ProviderResponse['metadata'],
  ctx: StreamMetricsCtx
): Promise<ProviderResponse> => {
  const events = wrapIfTelHooks(eventStream, request, ctx)
  let message: AssistantMessage | undefined
  for await (const event of events) {
    if (event.type === 'done') message = event.message
    if (event.type === 'error') {
      // Route through mapAuthError so an in-stream OAuth-refresh failure becomes a
      // DispatchAuthError (→ 401) instead of a generic 502. metadata.provider names
      // the backing provider for the login hint.
      throw mapAuthError(
        new Error(event.error.errorMessage ?? 'pi-ai stream error'),
        metadata.provider
      )
    }
  }
  if (!message) throw new Error('No response from pi-ai stream')
  return {
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: formatJson(request.format, message, request.id, request.model),
    metadata
  }
}
