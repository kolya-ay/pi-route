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
    const base = new URL(baseUrl)
    // Bare-origin upstreams expect the original /v1/... path. Upstreams with a
    // non-root base path (e.g. /api/v1) need only the endpoint tail appended.
    const basePath = base.pathname.replace(/\/$/, '')
    const endpointPath =
      basePath === '' || basePath === '/'
        ? originalUrl.pathname
        : originalUrl.pathname.replace(/^\/v1\//, '')
    const baseWithSlash = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
    const rewrittenUrl = new URL(
      endpointPath.replace(/^\//, '') + originalUrl.search,
      baseWithSlash
    ).toString()

    const upstream = new Request(rewrittenUrl, {
      method: request.rawRequest.method,
      headers,
      body: request.rawRequest.body,
      duplex: 'half'
    } as RequestInit)

    const response = await fetchFn(upstream)
    const latencyMs = Date.now() - start

    const contentType = response.headers.get('content-type') ?? ''
    let body: ProviderResponse['body']
    if (contentType.includes('text/event-stream')) {
      body = response.body as ReadableStream
    } else {
      // Read once, then parse. response.json() throws an opaque "Failed to
      // parse JSON" when upstreams return text/* error pages (NVIDIA 404,
      // Cloudflare HTML, etc.); reading text() first lets us surface the
      // real upstream body to the caller.
      const text = await response.text()
      try {
        body = JSON.parse(text) as Record<string, unknown>
      } catch {
        body = {
          error: 'upstream returned non-JSON response',
          upstreamStatus: response.status,
          upstreamContentType: contentType || null,
          upstreamBody: text.length > 2048 ? `${text.slice(0, 2048)}…` : text
        }
      }
    }

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
