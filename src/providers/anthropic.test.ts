// src/providers/anthropic.test.ts

import { describe, expect, it, mock } from 'bun:test'
import type { Account, IncomingRequest } from '../types'
import { createAnthropicProvider } from './anthropic'

const mkRequest = (overrides: Partial<IncomingRequest> = {}): IncomingRequest => ({
  id: 'req-1',
  format: 'anthropic',
  model: 'claude-sonnet-4-6',
  stream: false,
  rawRequest: new Request('http://x/v1/messages', {
    method: 'POST',
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }]
    })
  }),
  ...overrides
})

const mkAccount = (): Account => ({ credential: 'key', key: 'sk-ant-xxx' })

describe('createAnthropicProvider', () => {
  it('returns a Provider with type anthropic and the given name', () => {
    const p = createAnthropicProvider('claude-max')
    expect(p.name).toBe('claude-max')
    expect(p.type).toBe('anthropic')
  })

  it('throws if the requested model is not in pi-ai catalog', async () => {
    const p = createAnthropicProvider('claude-max')
    const req = mkRequest({ model: 'claude-bogus-99' })
    await expect(p.dispatch(req, mkAccount(), 'sk-ant-xxx')).rejects.toThrow(/not in pi-ai catalog/)
  })

  it('streams an SSE response when request.stream is true', async () => {
    const piAi = await import('@mariozechner/pi-ai/anthropic')
    const fakeStream = {
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'done' as const,
          message: {
            role: 'assistant' as const,
            content: [{ type: 'text' as const, text: 'hello' }],
            api: 'anthropic-messages' as const,
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
            },
            stopReason: 'stop' as const,
            timestamp: Date.now()
          }
        }
      }
    }
    const stub = mock((_model: unknown, _ctx: unknown, _opts: unknown) => fakeStream)
    mock.module('@mariozechner/pi-ai/anthropic', () => ({ ...piAi, streamAnthropic: stub }))

    try {
      const p = createAnthropicProvider('claude-max')
      const req = mkRequest({ stream: true })
      const res = await p.dispatch(req, mkAccount(), 'sk-ant-xxx')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/event-stream')
      expect(stub).toHaveBeenCalledTimes(1)
      // Third arg to streamAnthropic is the options object with apiKey
      expect(stub.mock.calls[0]?.[2]).toEqual({ apiKey: 'sk-ant-xxx' })
    } finally {
      mock.module('@mariozechner/pi-ai/anthropic', () => piAi)
    }
  })
})
