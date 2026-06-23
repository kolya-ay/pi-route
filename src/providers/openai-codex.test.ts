import { describe, expect, it, mock } from 'bun:test'
import type { AssistantMessageEventStream } from '@mariozechner/pi-ai'
import type { Account, IncomingRequest } from '../types'
import { createOpenAICodexProvider } from './openai-codex'

const makeRequest = (opts: { stream: boolean }): IncomingRequest => ({
  id: 'req-1',
  format: 'openai',
  rawRequest: new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'gpt-4.1-codex',
      messages: [{ role: 'user', content: 'hi' }],
      stream: opts.stream
    })
  }),
  model: 'gpt-4.1-codex',
  stream: opts.stream
})

const account: Account = { type: 'openai-codex-oauth', name: 'me@example.com' }

const stubCodexStream = async (
  handler: (model: unknown, ctx: unknown, opts: unknown) => unknown
) => {
  const piModule = await import('@mariozechner/pi-ai/openai-codex-responses')
  const original = piModule.streamOpenAICodexResponses
  const stub = mock(handler)
  mock.module('@mariozechner/pi-ai/openai-codex-responses', () => ({
    streamOpenAICodexResponses: stub
  }))
  return {
    stub,
    restore: () => {
      mock.module('@mariozechner/pi-ai/openai-codex-responses', () => ({
        streamOpenAICodexResponses: original
      }))
    }
  }
}

const pushDoneEvent = (stream: AssistantMessageEventStream) => {
  queueMicrotask(() => {
    stream.push({
      type: 'done',
      reason: 'stop',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        api: 'openai-codex-responses',
        provider: 'openai-codex-responses',
        model: 'gpt-4.1-codex',
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
      }
    })
  })
}

describe('createOpenAICodexProvider', () => {
  it('streams via pi-ai and serializes as SSE when stream=true', async () => {
    const piAi = await import('@mariozechner/pi-ai')
    const { stub, restore } = await stubCodexStream((model, _ctx, opts) => {
      expect((opts as { apiKey?: string }).apiKey).toBe('jwt-here')
      expect((model as { id: string }).id).toBe('gpt-4.1-codex')
      const stream = piAi.createAssistantMessageEventStream()
      pushDoneEvent(stream)
      return stream
    })

    try {
      const provider = createOpenAICodexProvider('codex')
      const response = await provider.dispatch(makeRequest({ stream: true }), account, 'jwt-here')
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/event-stream')
      expect(response.body instanceof ReadableStream).toBe(true)
      expect(stub).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })

  it('returns JSON when stream=false', async () => {
    const piAi = await import('@mariozechner/pi-ai')
    const { restore } = await stubCodexStream(() => {
      const stream = piAi.createAssistantMessageEventStream()
      pushDoneEvent(stream)
      return stream
    })

    try {
      const provider = createOpenAICodexProvider('codex')
      const response = await provider.dispatch(makeRequest({ stream: false }), account, 'jwt-here')
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/json')
      expect(typeof response.body).toBe('object')
    } finally {
      restore()
    }
  })
})
