// src/providers/openai-codex.ts

import type { AssistantMessage, Model } from '@mariozechner/pi-ai'
import { streamOpenAICodexResponses } from '@mariozechner/pi-ai/openai-codex-responses'

import type { Account, IncomingRequest, Provider, ProviderResponse } from '../types'

import { anthropicToContext, openaiToContext } from './to-context'
import {
  anthropicMessageToJson,
  createAnthropicSseStream,
  createOpenAiSseStream,
  openaiMessageToJson
} from './to-sse'

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
    const context =
      request.format === 'anthropic' ? anthropicToContext(body) : openaiToContext(body)

    const model = {
      id: request.model,
      api: 'openai-codex-responses',
      provider: 'openai-codex-responses',
      maxTokens: (body.max_tokens as number) ?? 8192
    } as Model<'openai-codex-responses'>

    const eventStream = streamOpenAICodexResponses(model, context, { apiKey })

    const metadata = {
      requestId: request.id,
      provider: name,
      model: request.model,
      latencyMs: Date.now() - start,
      account: account.name
    }

    if (request.stream) {
      const sseBody =
        request.format === 'anthropic'
          ? createAnthropicSseStream(eventStream, request.id, request.model)
          : createOpenAiSseStream(eventStream, request.id, request.model)

      return {
        status: 200,
        headers: new Headers({
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        }),
        body: sseBody,
        metadata
      }
    }

    let message: AssistantMessage | undefined
    for await (const event of eventStream) {
      if (event.type === 'done') message = event.message
      if (event.type === 'error') {
        throw new Error(event.error.errorMessage ?? 'OpenAI Codex stream error')
      }
    }
    if (!message) throw new Error('No response from OpenAI Codex stream')

    const responseBody =
      request.format === 'anthropic'
        ? anthropicMessageToJson(message, request.id, request.model)
        : openaiMessageToJson(message, request.id, request.model)

    return {
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: responseBody,
      metadata
    }
  }
})
