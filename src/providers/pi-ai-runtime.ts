// src/providers/pi-ai-runtime.ts

import type { AssistantMessage, AssistantMessageEventStream } from '@mariozechner/pi-ai'

import type { Account, IncomingRequest, ProviderResponse } from '../types'

import {
  anthropicMessageToJson,
  createAnthropicSseStream,
  createOpenAiSseStream,
  openaiMessageToJson
} from './to-sse'

export const capMaxTokens = <M extends { maxTokens: number }>(
  model: M,
  body: Record<string, unknown>
): M => {
  const requested = body.max_tokens
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) return model
  return { ...model, maxTokens: Math.min(requested, model.maxTokens) }
}

export const makeMetadata = (
  request: IncomingRequest,
  providerName: string,
  account: Account,
  startMs: number
): ProviderResponse['metadata'] => ({
  requestId: request.id,
  provider: providerName,
  model: request.model,
  latencyMs: Date.now() - startMs,
  ...('name' in account ? { account: account.name } : {})
})

export const streamingResponse = (
  eventStream: AssistantMessageEventStream,
  request: IncomingRequest,
  metadata: ProviderResponse['metadata']
): ProviderResponse => ({
  status: 200,
  headers: new Headers({
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  }),
  body:
    request.format === 'anthropic'
      ? createAnthropicSseStream(eventStream, request.id, request.model)
      : createOpenAiSseStream(eventStream, request.id, request.model),
  metadata
})

// Collect-and-serialize for non-streaming. Throws on mid-stream error so the
// dispatch.ts catch-wrapper can surface a 502 + provider_error telemetry.
export const jsonResponse = async (
  eventStream: AssistantMessageEventStream,
  request: IncomingRequest,
  metadata: ProviderResponse['metadata']
): Promise<ProviderResponse> => {
  let message: AssistantMessage | undefined
  for await (const event of eventStream) {
    if (event.type === 'done') message = event.message
    if (event.type === 'error') {
      throw new Error(event.error.errorMessage ?? 'pi-ai stream error')
    }
  }
  if (!message) throw new Error('No response from pi-ai stream')
  return {
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    body:
      request.format === 'anthropic'
        ? anthropicMessageToJson(message, request.id, request.model)
        : openaiMessageToJson(message, request.id, request.model),
    metadata
  }
}
