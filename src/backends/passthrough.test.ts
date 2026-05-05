// src/backends/passthrough.test.ts

import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Account, IncomingRequest } from '../types.js'
import { createPassthroughAnthropicBackend } from './passthrough-anthropic.js'
import { createPassthroughOpenAIBackend } from './passthrough-openai.js'

const makeAccount = (name: string, key: string): Account => ({
  type: 'api-key',
  name,
  key,
})

const makeRequest = (url: string, overrides?: Partial<IncomingRequest>): IncomingRequest => ({
  id: 'req-1',
  format: 'anthropic',
  rawRequest: new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-3-5-sonnet', messages: [] }),
  }),
  model: 'claude-3-5-sonnet',
  stream: false,
  ...overrides,
})

// --- Mock Anthropic server ---

const mockAnthropicApp = new Hono()

mockAnthropicApp.post('/v1/messages', (c) => {
  const key = c.req.header('x-api-key')
  if (!key) return c.json({ error: 'missing x-api-key' }, 401)
  return c.json({
    id: 'msg-mock',
    type: 'message',
    model: 'claude-3-5-sonnet',
    content: [{ type: 'text', text: 'hello' }],
    apiKey: key,
  })
})

// --- Mock OpenAI server ---

const mockOpenAIApp = new Hono()

mockOpenAIApp.post('/v1/chat/completions', (c) => {
  const auth = c.req.header('authorization')
  if (!auth) return c.json({ error: 'missing authorization' }, 401)
  return c.json({
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    model: 'gpt-4o',
    choices: [],
    authHeader: auth,
  })
})

// --- Tests ---

describe('createPassthroughAnthropicBackend', () => {
  it('forwards request and returns response with model in body', async () => {
    const backend = createPassthroughAnthropicBackend(
      'anthropic',
      async (req: Request) => mockAnthropicApp.fetch(req),
    )
    const account = makeAccount('test-account', 'sk-ant-test')
    const request = makeRequest('https://api.anthropic.com/v1/messages')

    const result = await backend.dispatch(request, account)

    expect(result.status).toBe(200)
    expect(result.metadata.backend).toBe('anthropic')
    expect(result.metadata.account).toBe('test-account')
    const body = result.body as Record<string, unknown>
    expect(body.model).toBe('claude-3-5-sonnet')
  })

  it('sets x-api-key header from account key', async () => {
    let capturedKey: string | null = null
    const capturingFetch = async (req: Request): Promise<Response> => {
      capturedKey = req.headers.get('x-api-key')
      return mockAnthropicApp.fetch(req)
    }

    const backend = createPassthroughAnthropicBackend('anthropic', capturingFetch)
    const account = makeAccount('test-account', 'sk-ant-secret')
    const request = makeRequest('https://api.anthropic.com/v1/messages')

    await backend.dispatch(request, account)

    expect(capturedKey).toBe('sk-ant-secret')
  })

  it('removes authorization header when forwarding', async () => {
    let capturedAuth: string | null = 'present'
    const capturingFetch = async (req: Request): Promise<Response> => {
      capturedAuth = req.headers.get('authorization')
      return mockAnthropicApp.fetch(req)
    }

    const backend = createPassthroughAnthropicBackend('anthropic', capturingFetch)
    const account = makeAccount('test-account', 'sk-ant-secret')
    const rawRequest = new Request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer old-token',
      },
      body: JSON.stringify({ model: 'claude-3-5-sonnet', messages: [] }),
    })
    const request = makeRequest('https://api.anthropic.com/v1/messages', { rawRequest })

    await backend.dispatch(request, account)

    expect(capturedAuth).toBeNull()
  })
})

describe('createPassthroughOpenAIBackend', () => {
  it('forwards request and returns response', async () => {
    const backend = createPassthroughOpenAIBackend(
      'openai',
      'https://api.openai.com',
      async (req: Request) => mockOpenAIApp.fetch(req),
    )
    const account = makeAccount('test-account', 'sk-openai-test')
    const request = makeRequest('https://my-router.example.com/v1/chat/completions', {
      format: 'openai',
      model: 'gpt-4o',
    })

    const result = await backend.dispatch(request, account)

    expect(result.status).toBe(200)
    expect(result.metadata.backend).toBe('openai')
    const body = result.body as Record<string, unknown>
    expect(body.object).toBe('chat.completion')
  })

  it('sets Authorization Bearer header from account key', async () => {
    let capturedAuth: string | null = null
    const capturingFetch = async (req: Request): Promise<Response> => {
      capturedAuth = req.headers.get('authorization')
      return mockOpenAIApp.fetch(req)
    }

    const backend = createPassthroughOpenAIBackend('openai', 'https://api.openai.com', capturingFetch)
    const account = makeAccount('test-account', 'sk-openai-secret')
    const request = makeRequest('https://my-router.example.com/v1/chat/completions', {
      format: 'openai',
      model: 'gpt-4o',
    })

    await backend.dispatch(request, account)

    expect(capturedAuth).toBe('Bearer sk-openai-secret')
  })

  it('rewrites URL origin to baseUrl while keeping pathname', async () => {
    let capturedUrl: string | null = null
    const capturingFetch = async (req: Request): Promise<Response> => {
      capturedUrl = req.url
      return mockOpenAIApp.fetch(req)
    }

    const backend = createPassthroughOpenAIBackend(
      'openai',
      'https://api.openai.com',
      capturingFetch,
    )
    const account = makeAccount('test-account', 'sk-openai-secret')
    const request = makeRequest('https://my-router.example.com/v1/chat/completions', {
      format: 'openai',
      model: 'gpt-4o',
    })

    await backend.dispatch(request, account)

    expect(capturedUrl).toBe('https://api.openai.com/v1/chat/completions')
  })
})
