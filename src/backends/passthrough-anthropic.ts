// src/backends/passthrough-anthropic.ts

import type { Account, Backend, BackendResponse, IncomingRequest } from '../types'

export const createPassthroughAnthropicBackend = (
  name: string,
  fetchFn: (req: Request) => Promise<Response> = (req) => globalThis.fetch(req)
): Backend => ({
  name,
  type: 'passthrough-anthropic',

  async dispatch(request: IncomingRequest, account: Account): Promise<BackendResponse> {
    if (!account.resolveKey) throw new Error(`Account '${account.name}' has no resolveKey`)
    const apiKey = await account.resolveKey()
    const start = Date.now()

    const headers = new Headers(request.rawRequest.headers)
    headers.set('x-api-key', apiKey)
    headers.delete('authorization')

    const upstream = new Request(
      request.rawRequest.url,
      // duplex: 'half' is required for streaming request bodies in Node.js
      {
        method: request.rawRequest.method,
        headers,
        body: request.rawRequest.body,
        duplex: 'half'
      } as RequestInit
    )

    const response = await fetchFn(upstream)
    const latencyMs = Date.now() - start

    const contentType = response.headers.get('content-type') ?? ''
    const body: BackendResponse['body'] = contentType.includes('text/event-stream')
      ? (response.body as ReadableStream)
      : ((await response.json()) as Record<string, unknown>)

    return {
      status: response.status,
      headers: response.headers,
      body,
      metadata: {
        requestId: request.id,
        backend: name,
        model: request.model,
        latencyMs,
        account: account.name
      }
    }
  }
})
