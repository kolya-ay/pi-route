// src/providers/openai-codex.ts

import { getModel } from '@mariozechner/pi-ai'
import { streamOpenAICodexResponses } from '@mariozechner/pi-ai/openai-codex-responses'
import type { Account, IncomingRequest, Provider, ProviderResponse } from '../types'
import {
  capMaxTokens,
  jsonResponse,
  makeMetadata,
  RETRY_OPTIONS,
  streamingResponse
} from './pi-ai-runtime'
import { toContext } from './to-context'

export const createOpenAICodexProvider = (name: string): Provider => ({
  name,
  type: 'openai-codex',

  async dispatch(
    request: IncomingRequest,
    account: Account,
    apiKey: string
  ): Promise<ProviderResponse> {
    const start = Date.now()
    const body = JSON.parse(await request.rawRequest.text()) as Record<string, unknown>
    const context = toContext(request.format, body)

    // Pi-ai's response code reads model.input/cost/etc — a hand-rolled stub
    // crashes at runtime. Catalog lookup is required for Codex (no fallback).
    const catalogModel = getModel(
      'openai-codex',
      request.model as Parameters<typeof getModel<'openai-codex', never>>[1]
    )
    if (!catalogModel) {
      throw new Error(`openai-codex model "${request.model}" not in pi-ai catalog`)
    }
    const model = capMaxTokens(catalogModel, body)

    const eventStream = streamOpenAICodexResponses(model, context, {
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
