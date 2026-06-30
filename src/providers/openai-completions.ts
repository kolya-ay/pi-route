// src/providers/openai-completions.ts

import { getModel, type KnownProvider, type Model } from '@mariozechner/pi-ai'
import { streamOpenAICompletions } from '@mariozechner/pi-ai/openai-completions'
import type { Account, IncomingRequest, Provider, ProviderResponse } from '../types'
import {
  capMaxTokens,
  jsonResponse,
  makeMetadata,
  RETRY_OPTIONS,
  streamingResponse
} from './pi-ai-runtime'
import { toContext } from './to-context'

// Which provider types have a pi-ai catalog entry to consult first.
// 'openai-compatible' (used by nvidia, chutes) intentionally absent — those
// always go through the constructed-Model path.
const CATALOG_PROVIDER: Partial<Record<Provider['type'], KnownProvider>> = {
  cerebras: 'cerebras',
  openrouter: 'openrouter'
}

const constructModel = (
  modelId: string,
  baseUrl: string,
  type: Provider['type']
): Model<'openai-completions'> => ({
  id: modelId,
  name: modelId,
  api: 'openai-completions',
  provider: type,
  baseUrl,
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096
})

export const createOpenAICompletionsProvider = (
  name: string,
  type: Provider['type'],
  baseUrl: string
): Provider => ({
  name,
  type,

  async dispatch(
    request: IncomingRequest,
    account: Account,
    apiKey: string
  ): Promise<ProviderResponse> {
    const start = Date.now()
    const body = JSON.parse(await request.rawRequest.text()) as Record<string, unknown>
    const context = toContext(request.format, body)

    const catalogProvider = CATALOG_PROVIDER[type]
    const baseModel =
      (catalogProvider &&
        (getModel(catalogProvider as never, request.model as never) as
          | Model<'openai-completions'>
          | undefined)) ??
      constructModel(request.model, baseUrl, type)
    const model = capMaxTokens(baseModel, body)

    const eventStream = streamOpenAICompletions(model, context, {
      apiKey,
      maxTokens: model.maxTokens,
      signal: request.rawRequest.signal,
      ...RETRY_OPTIONS
    })
    const metadata = makeMetadata(request, name, account, start)
    const ctx = { costs: { inputCost: model.cost.input, outputCost: model.cost.output } }

    return request.stream
      ? streamingResponse(eventStream, request, metadata, ctx)
      : jsonResponse(eventStream, request, metadata, ctx)
  }
})
