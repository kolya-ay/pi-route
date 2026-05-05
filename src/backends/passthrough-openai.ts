// src/backends/passthrough-openai.ts

import { resolveApiKey } from '../auth/credentials.js'
import type { Account, Backend, BackendResponse, IncomingRequest } from '../types.js'

export const createPassthroughOpenAIBackend = (
  name: string,
  baseUrl: string,
  fetchFn: (req: Request) => Promise<Response> = (req) => globalThis.fetch(req),
): Backend => ({
  name,
  type: 'passthrough-openai',

  async dispatch(request: IncomingRequest, account: Account): Promise<BackendResponse> {
    const apiKey = resolveApiKey(account)
    const start = Date.now()

    const headers = new Headers(request.rawRequest.headers)
    headers.set('authorization', `Bearer ${apiKey}`)
    headers.delete('x-api-key')

    const originalUrl = new URL(request.rawRequest.url)
    const rewrittenUrl = new URL(originalUrl.pathname, baseUrl).toString()

    const upstream = new Request(
      rewrittenUrl,
      // duplex: 'half' is required for streaming request bodies in Node.js
      { method: request.rawRequest.method, headers, body: request.rawRequest.body, duplex: 'half' } as RequestInit,
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
        account: account.name,
      },
    }
  },
})
