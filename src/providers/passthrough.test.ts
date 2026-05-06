// src/providers/passthrough.test.ts

import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'

import type { Account, IncomingRequest } from '../types'

import { createPassthroughProvider } from './passthrough'

const makeRequest = (url: string, headers: Record<string, string> = {}): IncomingRequest => ({
  id: 'req-test',
  format: 'anthropic',
  rawRequest: new Request(url, { method: 'POST', headers, body: '{}' }),
  model: 'claude-3-5-sonnet',
  stream: false
})

const makeAccount = (key: string): Account => ({
  type: 'api-key',
  name: 'test-account',
  resolveKey: () => key
})

const startMockServer = (app: Hono): { baseUrl: string; close: () => void } => {
  const server = Bun.serve({ fetch: app.fetch, port: 0 })
  return { baseUrl: `http://localhost:${server.port}`, close: () => server.stop() }
}

describe('createPassthroughProvider: anthropic', () => {
  it('forwards request and sets x-api-key, removes authorization', async () => {
    const mock = new Hono()
    let capturedHeaders: Headers | undefined

    mock.post('/v1/messages', (c) => {
      capturedHeaders = new Headers(c.req.raw.headers)
      return c.json({ id: 'msg_123', type: 'message' })
    })

    const { baseUrl, close } = startMockServer(mock)

    try {
      const provider = createPassthroughProvider('test-anthropic', 'anthropic', baseUrl)
      const request = makeRequest(`${baseUrl}/v1/messages`, {
        authorization: 'Bearer old-token',
        'content-type': 'application/json'
      })
      const account = makeAccount('sk-ant-test-key')

      const response = await provider.dispatch(request, account)

      expect(response.status).toBe(200)
      expect(capturedHeaders?.get('x-api-key')).toBe('sk-ant-test-key')
      expect(capturedHeaders?.get('authorization')).toBeNull()
      expect(response.metadata.provider).toBe('test-anthropic')
      expect(response.metadata.requestId).toBe('req-test')
      expect(response.metadata.model).toBe('claude-3-5-sonnet')
      expect(response.metadata.account).toBe('test-account')
      expect(typeof response.metadata.latencyMs).toBe('number')
    } finally {
      close()
    }
  })

  it('returns ReadableStream body for SSE responses', async () => {
    const mock = new Hono()

    mock.post(
      '/v1/messages',
      (_c) =>
        new Response('data: {"type":"content_block_delta"}\n\n', {
          headers: { 'content-type': 'text/event-stream' }
        })
    )

    const { baseUrl, close } = startMockServer(mock)

    try {
      const provider = createPassthroughProvider('test-anthropic', 'anthropic', baseUrl)
      const request = makeRequest(`${baseUrl}/v1/messages`)
      const account = makeAccount('sk-ant-key')

      const response = await provider.dispatch(request, account)

      expect(response.body).toBeInstanceOf(ReadableStream)
    } finally {
      close()
    }
  })
})

describe('createPassthroughProvider: openai', () => {
  it('sets Bearer auth, rewrites URL origin, removes x-api-key', async () => {
    const mock = new Hono()
    let capturedHeaders: Headers | undefined
    let capturedPath: string | undefined

    mock.post('/v1/chat/completions', (c) => {
      capturedHeaders = new Headers(c.req.raw.headers)
      capturedPath = c.req.path
      return c.json({ id: 'chatcmpl-123', object: 'chat.completion' })
    })

    const { baseUrl, close } = startMockServer(mock)

    try {
      const provider = createPassthroughProvider('test-openai', 'openai', baseUrl)
      const request = makeRequest('http://router.internal/v1/chat/completions', {
        'x-api-key': 'should-be-removed',
        'content-type': 'application/json'
      })
      const account = makeAccount('sk-openai-test-key')

      const response = await provider.dispatch(request, account)

      expect(response.status).toBe(200)
      expect(capturedHeaders?.get('authorization')).toBe('Bearer sk-openai-test-key')
      expect(capturedHeaders?.get('x-api-key')).toBeNull()
      expect(capturedPath).toBe('/v1/chat/completions')
      expect(response.metadata.provider).toBe('test-openai')
    } finally {
      close()
    }
  })

  it('accepts a custom fetchFn', async () => {
    let fetchCalled = false
    const customFetch = async (_req: Request): Promise<Response> => {
      fetchCalled = true
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' }
      })
    }

    const provider = createPassthroughProvider(
      'test-custom',
      'openai',
      'https://api.openai.com',
      customFetch
    )
    const request = makeRequest('http://router.internal/v1/chat/completions')
    const account = makeAccount('sk-key')

    await provider.dispatch(request, account)

    expect(fetchCalled).toBe(true)
  })
})
