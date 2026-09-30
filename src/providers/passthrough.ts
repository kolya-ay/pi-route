// src/providers/passthrough.ts

import type {
  Account,
  FormatTranslationMode,
  IncomingRequest,
  Provider,
  ProviderResponse
} from '../types'

import { UpstreamError } from './models-dispatch'

// Upstream error bodies vary (OpenAI JSON, gateway HTML); name the message when
// the body carries one, else show the body itself.
const errorDetail = (text: string): string => {
  try {
    const error = (JSON.parse(text) as { error?: { message?: unknown } | string }).error
    const message = typeof error === 'string' ? error : error?.message
    if (typeof message === 'string') return message
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return text.trim() || '(no body)'
}

export const createPassthroughProvider = (
  name: string,
  type: Provider['type'],
  baseUrl: string,
  formatTranslation: FormatTranslationMode = 'auto',
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

    // Raw passthrough can only enforce a schema the upstream already understands:
    // it forwards bytes, so it can neither inject a private tool nor rewrite that
    // tool's stream back into text.
    if (request.structuredOutput) {
      const nativeSurface =
        type === 'openai' && (request.format === 'openai' || request.format === 'responses')
      if (formatTranslation === 'constrained-tool' || !nativeSurface) {
        throw new Error(
          `formatTranslation ${formatTranslation} cannot enforce json_schema for raw ${type} passthrough`
        )
      }
    }

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
      duplex: 'half',
      signal: request.rawRequest.signal
    } as RequestInit)

    const response = await fetchFn(upstream)
    const latencyMs = Date.now() - start

    // A non-2xx has reached no client yet: throwing lets dispatch fail over.
    if (!response.ok) {
      const detail = errorDetail(await response.text()).slice(0, 200)
      throw new UpstreamError(`${response.status} ${detail}`, response.status)
    }

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
