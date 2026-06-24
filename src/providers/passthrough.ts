// src/providers/passthrough.ts

import type { Account, IncomingRequest, Provider, ProviderResponse } from '../types'

export const createPassthroughProvider = (
  name: string,
  type: Provider['type'],
  baseUrl: string,
  fetchFn: (req: Request) => Promise<Response> = (req) => globalThis.fetch(req)
): Provider => ({
  name,
  type,

  async dispatch(
    request: IncomingRequest,
    account: Account,
    apiKey: string
  ): Promise<ProviderResponse> {
    const start = Date.now()

    const headers = new Headers(request.rawRequest.headers)

    if (type === 'anthropic') {
      headers.set('x-api-key', apiKey)
      headers.delete('authorization')
    } else {
      headers.set('authorization', `Bearer ${apiKey}`)
      headers.delete('x-api-key')
    }

    const originalUrl = new URL(request.rawRequest.url)
    const rewrittenUrl = new URL(originalUrl.pathname, baseUrl).toString()

    const upstream = new Request(rewrittenUrl, {
      method: request.rawRequest.method,
      headers,
      body: request.rawRequest.body,
      duplex: 'half'
    } as RequestInit)

    const response = await fetchFn(upstream)
    const latencyMs = Date.now() - start

    const contentType = response.headers.get('content-type') ?? ''
    const body: ProviderResponse['body'] = contentType.includes('text/event-stream')
      ? (response.body as ReadableStream)
      : ((await response.json()) as Record<string, unknown>)

    return {
      status: response.status,
      headers: response.headers,
      body,
      metadata: {
        requestId: request.id,
        provider: name,
        model: request.model,
        latencyMs,
        ...('name' in account ? { account: account.name } : {})
      }
    }
  }
})
