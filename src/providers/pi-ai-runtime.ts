// src/providers/pi-ai-runtime.ts

import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream
} from '@earendil-works/pi-ai'

import type { PerTokenUsd } from '../pipeline/money'
import { wrapStreamForMetrics } from '../telemetry/stream-metrics'
import type { IncomingRequest, ProviderResponse } from '../types'

import { mapAuthError, UpstreamError, upstreamError } from './models-dispatch'
import { describeStreamError, formatJson, formatSse } from './to-sse'

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

// Applied after telemetry wrapping so metrics still observe the real upstream
// events while the public serializers see the rewritten ones.
export type EventTransform = (
  events: AsyncIterable<AssistantMessageEvent>
) => AsyncIterable<AssistantMessageEvent>

const prepareEvents = (
  eventStream: AssistantMessageEventStream,
  request: IncomingRequest,
  ctx: StreamMetricsCtx,
  transform?: EventTransform
): AsyncIterable<AssistantMessageEvent> => {
  const measured =
    request.telHooks === undefined
      ? eventStream
      : wrapStreamForMetrics(
          eventStream,
          request.telHooks.span,
          request.telHooks.tel,
          ctx.costs,
          request.telHooks.capture
        )
  return transform ? transform(measured) : measured
}

type Events = AsyncIterator<AssistantMessageEvent>

// Reads until the first event the client would see. `start` and `text_start` carry
// no content, so they are held: an error behind them has reached nobody yet and the
// dispatch loop can still move to the next candidate.
const readUntilContent = async (
  iterator: Events,
  provider: string,
  held: AssistantMessageEvent[] = []
): Promise<AssistantMessageEvent[]> => {
  const next = await iterator.next()
  if (next.done) throw new UpstreamError('No response from pi-ai stream')
  const event = next.value
  if (event.type === 'error') {
    throw mapAuthError(upstreamError(describeStreamError(event.error)), provider)
  }
  return event.type === 'start' || event.type === 'text_start'
    ? readUntilContent(iterator, provider, [...held, event])
    : [...held, event]
}

const resume = async function* (
  held: AssistantMessageEvent[],
  iterator: Events
): AsyncIterable<AssistantMessageEvent> {
  yield* held
  yield* { [Symbol.asyncIterator]: () => iterator }
}

// Commits only once content starts, so a failure before it throws like jsonResponse
// does and the dispatch loop fails over; after it, errors stay in-band.
export const streamingResponse = async (
  eventStream: AssistantMessageEventStream,
  request: IncomingRequest,
  metadata: ProviderResponse['metadata'],
  ctx: StreamMetricsCtx,
  transform?: EventTransform
): Promise<ProviderResponse> => {
  const iterator = prepareEvents(eventStream, request, ctx, transform)[Symbol.asyncIterator]()
  const held = await readUntilContent(iterator, metadata.provider)
  return {
    status: 200,
    headers: new Headers({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    }),
    body: formatSse(request.format, resume(held, iterator), request.id, request.model),
    metadata
  }
}

// Collect-and-serialize for non-streaming. Throws on an in-stream error so
// dispatch fails over.
export const jsonResponse = async (
  eventStream: AssistantMessageEventStream,
  request: IncomingRequest,
  metadata: ProviderResponse['metadata'],
  ctx: StreamMetricsCtx,
  transform?: EventTransform
): Promise<ProviderResponse> => {
  const events = prepareEvents(eventStream, request, ctx, transform)
  let message: AssistantMessage | undefined
  for await (const event of events) {
    if (event.type === 'done') message = event.message
    if (event.type === 'error') {
      // Route through mapAuthError so an in-stream OAuth-refresh failure becomes a
      // DispatchAuthError (→ 401) instead of a generic 502. metadata.provider names
      // the backing provider for the login hint.
      throw mapAuthError(upstreamError(describeStreamError(event.error)), metadata.provider)
    }
  }
  if (!message) throw new UpstreamError('No response from pi-ai stream')
  return {
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: formatJson(request.format, message, request.id, request.model),
    metadata
  }
}
