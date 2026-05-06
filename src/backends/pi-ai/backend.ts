// src/backends/pi-ai/backend.ts

import type { Api, AssistantMessage, Model } from '@mariozechner/pi-ai'
import { complete, stream } from '@mariozechner/pi-ai'

import type { Account, Backend, BackendResponse, IncomingRequest } from '../../types'

import { anthropicToContext, openaiToContext } from './to-context'
import {
  anthropicMessageToJson,
  createAnthropicSseStream,
  createOpenAiSseStream,
  openaiMessageToJson
} from './to-sse'

// --- Model registry ---

const models = new Map<string, Model<Api>>()

export const registerModel = (model: Model<Api>): void => {
  models.set(model.id, model)
}

export const getModel = (id: string): Model<Api> | undefined => models.get(id)

// --- SSE response headers ---

const sseHeaders = () =>
  new Headers({
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })

const jsonHeaders = () => new Headers({ 'content-type': 'application/json' })

// --- Extract token metadata from AssistantMessage ---

const extractTokens = (message: AssistantMessage) => ({
  input: message.usage.input,
  output: message.usage.output,
  cacheRead: message.usage.cacheRead,
  cacheWrite: message.usage.cacheWrite
})

const extractCost = (message: AssistantMessage) => ({
  input: message.usage.cost.input,
  output: message.usage.cost.output,
  total: message.usage.cost.total
})

// --- Backend factory ---

export const createPiAiBackend = (name: string, _provider: string): Backend => ({
  name,
  type: 'pi-ai',

  async dispatch(request: IncomingRequest, account: Account): Promise<BackendResponse> {
    if (!account.resolveKey) throw new Error(`Account '${account.name}' has no resolveKey`)
    const apiKey = await account.resolveKey()
    const start = Date.now()

    const body = JSON.parse(await request.rawRequest.text()) as Record<string, unknown>
    const context =
      request.format === 'anthropic' ? anthropicToContext(body) : openaiToContext(body)

    const model = getModel(request.model)
    if (!model) throw new Error(`Model '${request.model}' not found in pi-ai registry`)

    if (request.stream) {
      const eventStream = stream(model, context, { apiKey })
      const sseBody =
        request.format === 'anthropic'
          ? createAnthropicSseStream(eventStream, request.id, request.model)
          : createOpenAiSseStream(eventStream, request.id, request.model)

      return {
        status: 200,
        headers: sseHeaders(),
        body: sseBody,
        metadata: {
          requestId: request.id,
          backend: name,
          model: request.model,
          latencyMs: Date.now() - start,
          account: account.name
        }
      }
    }

    const message = await complete(model, context, { apiKey })
    const latencyMs = Date.now() - start

    const responseBody =
      request.format === 'anthropic'
        ? anthropicMessageToJson(message, request.id, request.model)
        : openaiMessageToJson(message, request.id, request.model)

    return {
      status: 200,
      headers: jsonHeaders(),
      body: responseBody,
      metadata: {
        requestId: request.id,
        backend: name,
        model: request.model,
        tokens: extractTokens(message),
        cost: extractCost(message),
        latencyMs,
        account: account.name
      }
    }
  }
})
