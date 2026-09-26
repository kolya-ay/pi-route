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

const makeAccount = (): Account => ({
  credential: 'key',
  key: 'k'
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
      const account = makeAccount()

      const response = await provider.dispatch(request, account, 'sk-ant-test-key')

      expect(response.status).toBe(200)
      expect(capturedHeaders?.get('x-api-key')).toBe('sk-ant-test-key')
      expect(capturedHeaders?.get('authorization')).toBeNull()
      expect(response.metadata.provider).toBe('test-anthropic')
      expect(response.metadata.requestId).toBe('req-test')
      expect(response.metadata.model).toBe('claude-3-5-sonnet')
      expect(response.metadata.account).toBeUndefined()
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
      const account = makeAccount()

      const response = await provider.dispatch(request, account, 'sk-ant-key')

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
      const account = makeAccount()

      const response = await provider.dispatch(request, account, 'sk-openai-test-key')

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
      'auto',
      customFetch
    )
    const request = makeRequest('http://router.internal/v1/chat/completions')
    const account = makeAccount()

    await provider.dispatch(request, account, 'sk-key')

    expect(fetchCalled).toBe(true)
  })
})

describe('createPassthroughProvider: structured output', () => {
  const constraint = {
    name: 'capital',
    schema: {
      type: 'object',
      properties: { capital: { type: 'string' } },
      required: ['capital'],
      additionalProperties: false
    }
  }

  const structuredRequest = (
    format: 'openai' | 'responses',
    body: Record<string, unknown>
  ): IncomingRequest => ({
    id: 'req-test',
    format,
    rawRequest: new Request(
      `http://router.internal/v1/${format === 'responses' ? 'responses' : 'chat/completions'}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }
    ),
    model: 'gpt-5',
    stream: false,
    structuredOutput: constraint
  })

  const recordingFetch = (seen: { body?: unknown }) => async (req: Request) => {
    seen.body = await req.json()
    return new Response('{}', { headers: { 'content-type': 'application/json' } })
  }

  it('forwards the chat schema field untouched', async () => {
    const seen: { body?: unknown } = {}
    const provider = createPassthroughProvider(
      'oa',
      'openai',
      'https://api.openai.com/v1',
      'native',
      recordingFetch(seen)
    )
    const response_format = {
      type: 'json_schema',
      json_schema: { name: 'capital', strict: true, schema: constraint.schema }
    }
    await provider.dispatch(
      structuredRequest('openai', { model: 'gpt-5', messages: [], response_format }),
      makeAccount(),
      'sk'
    )
    expect((seen.body as Record<string, unknown>).response_format).toEqual(response_format)
  })

  it('forwards the responses schema field untouched under auto', async () => {
    const seen: { body?: unknown } = {}
    const provider = createPassthroughProvider(
      'oa',
      'openai',
      'https://api.openai.com/v1',
      'auto',
      recordingFetch(seen)
    )
    const text = { format: { type: 'json_schema', name: 'capital', schema: constraint.schema } }
    await provider.dispatch(
      structuredRequest('responses', { model: 'gpt-5', input: 'hi', text }),
      makeAccount(),
      'sk'
    )
    expect((seen.body as Record<string, unknown>).text).toEqual(text)
  })

  it('refuses modes and upstreams it cannot enforce, before calling out', async () => {
    const cases: [string, 'auto' | 'native' | 'constrained-tool'][] = [
      ['openai', 'constrained-tool'],
      ['anthropic', 'auto']
    ]
    for (const [type, mode] of cases) {
      let called = false
      const provider = createPassthroughProvider(
        'p',
        type,
        'https://api.example.com/v1',
        mode,
        async () => {
          called = true
          return new Response('{}')
        }
      )
      await expect(
        provider.dispatch(
          structuredRequest('openai', { model: 'gpt-5', messages: [] }),
          makeAccount(),
          'sk'
        )
      ).rejects.toThrow(/json_schema/)
      expect(called).toBe(false)
    }
  })

  it('leaves requests without structured output unaffected by the policy', async () => {
    const seen: { body?: unknown } = {}
    const provider = createPassthroughProvider(
      'p',
      'anthropic',
      'https://api.anthropic.com',
      'constrained-tool',
      recordingFetch(seen)
    )
    await provider.dispatch(makeRequest('http://router.internal/v1/messages'), makeAccount(), 'sk')
    expect(seen.body).toEqual({})
  })
})
