// src/providers/models-dispatch.test.ts

import { describe, expect, it } from 'bun:test'
import type { Api, AssistantMessage, Model, Models } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream, ModelsError } from '@earendil-works/pi-ai'

import type { IncomingRequest } from '../types'
import { createModelsDispatch, DispatchAuthError, mapAuthError } from './models-dispatch'

const mkRequest = (overrides: Partial<IncomingRequest> = {}): IncomingRequest => ({
  id: 'req-1',
  format: 'anthropic',
  model: 'm',
  stream: false,
  rawRequest: new Request('http://x', {
    method: 'POST',
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
  }),
  ...overrides
})

const mkModel = (): Model<Api> => ({
  id: 'm',
  name: 'Model M',
  api: 'anthropic-messages',
  provider: 'prov',
  baseUrl: 'http://x',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 500
})

const mkMessage = (): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text: 'hello' }],
  api: 'anthropic-messages',
  provider: 'prov',
  model: 'm',
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  },
  stopReason: 'stop',
  timestamp: Date.now()
})

// Duck-typed Models: dispatch only reads .getModel and .stream.
const mkModels = (over: Partial<Pick<Models, 'getModel' | 'stream'>>): Models =>
  ({ getModel: () => mkModel(), stream: () => cannedStream(), ...over }) as unknown as Models

const cannedStream = () => {
  const stream = createAssistantMessageEventStream()
  const message = mkMessage()
  stream.push({ type: 'done', reason: 'stop', message })
  stream.end(message)
  return stream
}

describe('createModelsDispatch', () => {
  it('throws "model not found" for an unknown model', async () => {
    const provider = createModelsDispatch(mkModels({ getModel: () => undefined }), 'prov')
    await expect(
      provider.dispatch(mkRequest(), { credential: 'key', key: 'k' }, 'k')
    ).rejects.toThrow(/model not found/)
  })

  it('returns a 200 JSON ProviderResponse on the happy non-streaming path', async () => {
    const provider = createModelsDispatch(mkModels({ stream: () => cannedStream() }), 'prov')
    const res = await provider.dispatch(
      mkRequest({ stream: false }),
      { credential: 'key', key: 'k' },
      'k'
    )
    expect(res.status).toBe(200)
    expect(res.metadata.provider).toBe('prov')
    expect(res.metadata.model).toBe('m')
  })

  it('passes the capped model.maxTokens to models.stream', async () => {
    let captured: { maxTokens?: number } | undefined
    const stream = ((_model: Model<Api>, _context: unknown, options?: { maxTokens?: number }) => {
      captured = options
      return cannedStream()
    }) as unknown as Models['stream']
    const provider = createModelsDispatch(mkModels({ stream }), 'prov')
    // mkModel().maxTokens === 500; a body max_tokens of 16 must cap the value
    // handed to stream (openai-completions sets upstream max_tokens only from this).
    const rawRequest = new Request('http://x', {
      method: 'POST',
      body: JSON.stringify({
        model: 'm',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }]
      })
    })
    await provider.dispatch(
      mkRequest({ stream: false, rawRequest }),
      { credential: 'key', key: 'k' },
      'k'
    )
    expect(captured?.maxTokens).toBe(16)
  })
})

describe('mapAuthError', () => {
  it('maps a ModelsError("oauth") to a DispatchAuthError with a login hint', () => {
    const mapped = mapAuthError(new ModelsError('oauth', 'boom'), 'prov')
    expect(mapped).toBeInstanceOf(DispatchAuthError)
    expect((mapped as DispatchAuthError).message).toContain('pi-route login prov')
  })

  it('returns a plain Error unchanged', () => {
    const err = new Error('nope')
    expect(mapAuthError(err, 'prov')).toBe(err)
  })

  it('returns a ModelsError("auth") unchanged (only "oauth" maps)', () => {
    const err = new ModelsError('auth', 'nope')
    expect(mapAuthError(err, 'prov')).toBe(err)
  })
})
