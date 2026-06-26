// src/providers/anthropic.ts

import { getModel } from '@mariozechner/pi-ai'
import { streamAnthropic } from '@mariozechner/pi-ai/anthropic'

import type { Account, IncomingRequest, Provider, ProviderResponse } from '../types'

import { capMaxTokens, jsonResponse, makeMetadata, streamingResponse } from './pi-ai-runtime'
import { anthropicToContext, openaiToContext } from './to-context'

export const createAnthropicProvider = (name: string): Provider => ({
  name,
  type: 'anthropic',

  async dispatch(
    request: IncomingRequest,
    account: Account,
    apiKey: string
  ): Promise<ProviderResponse> {
    const start = Date.now()
    const body = JSON.parse(await request.rawRequest.text()) as Record<string, unknown>
    const context =
      request.format === 'anthropic' ? anthropicToContext(body) : openaiToContext(body)

    const catalogModel = getModel(
      'anthropic',
      request.model as Parameters<typeof getModel<'anthropic', never>>[1]
    )
    if (!catalogModel) {
      throw new Error(`anthropic model "${request.model}" not in pi-ai catalog`)
    }
    const model = capMaxTokens(catalogModel, body)

    const eventStream = streamAnthropic(model, context, { apiKey })
    const metadata = makeMetadata(request, name, account, start)

    return request.stream
      ? streamingResponse(eventStream, request, metadata)
      : jsonResponse(eventStream, request, metadata)
  }
})
