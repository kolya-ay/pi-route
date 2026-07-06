import { describe, expect, it, mock } from 'bun:test'
import { createAssistantMessageEventStream } from '@mariozechner/pi-ai'

import type { Account, IncomingRequest } from '../types'
import { createOpenAICompletionsProvider } from './openai-completions'

const account: Account = { credential: 'key', key: 'sk-test' }

const makeRequest = (opts: {
  format: 'anthropic' | 'openai'
  stream: boolean
  model?: string
  body?: Record<string, unknown>
}): IncomingRequest => {
  const model = opts.model ?? 'meta/llama-3.1-8b-instruct'
  const body = opts.body ?? {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    stream: opts.stream,
    max_tokens: 8
  }
  return {
    id: 'req-1',
    format: opts.format,
    rawRequest: new Request('http://localhost/v1/x', {
      method: 'POST',
      body: JSON.stringify(body)
    }),
    model,
    stream: opts.stream
  }
}

// Stubs streamOpenAICompletions globally for one test, restoring after.
const stubCompletions = async (
  handler: (model: unknown, ctx: unknown, opts: unknown) => unknown
) => {
  const piModule = await import('@mariozechner/pi-ai/openai-completions')
  const original = piModule.streamOpenAICompletions
  const stub = mock(handler)
  mock.module('@mariozechner/pi-ai/openai-completions', () => ({
    streamOpenAICompletions: stub
  }))
  return {
    stub,
    restore: () => {
      mock.module('@mariozechner/pi-ai/openai-completions', () => ({
        streamOpenAICompletions: original
      }))
    }
  }
}

const pushDone = (stream: ReturnType<typeof createAssistantMessageEventStream>, model: string) =>
  queueMicrotask(() => {
    stream.push({
      type: 'done',
      reason: 'stop',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        api: 'openai-completions',
        provider: 'test',
        model,
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

describe('createOpenAICompletionsProvider', () => {
  it('anthropic-format request feeds anthropicToContext output to pi-ai', async () => {
    let capturedCtx: unknown
    const { restore } = await stubCompletions((_m, ctx, _opts) => {
      capturedCtx = ctx
      const ev = createAssistantMessageEventStream()
      pushDone(ev, 'meta/llama-3.1-8b-instruct')
      return ev
    })
    try {
      const p = createOpenAICompletionsProvider('nvidia', 'openai-compatible', 'https://x/v1')
      const body = {
        model: 'meta/llama-3.1-8b-instruct',
        system: 'be brief',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 8
      }
      const req = makeRequest({ format: 'anthropic', stream: false, body })
      await p.dispatch(req, account, 'k')
      // anthropicToContext puts system at top-level systemPrompt;
      // openaiToContext would have looked for a 'system' role message.
      expect((capturedCtx as { systemPrompt?: string }).systemPrompt).toBe('be brief')
    } finally {
      restore()
    }
  })

  it('openai-format request feeds openaiToContext output to pi-ai', async () => {
    let capturedCtx: unknown
    const { restore } = await stubCompletions((_m, ctx, _opts) => {
      capturedCtx = ctx
      const ev = createAssistantMessageEventStream()
      pushDone(ev, 'gpt-oss-120b')
      return ev
    })
    try {
      const p = createOpenAICompletionsProvider(
        'cerebras',
        'cerebras',
        'https://api.cerebras.ai/v1'
      )
      const body = {
        model: 'gpt-oss-120b',
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hi' }
        ]
      }
      const req = makeRequest({ format: 'openai', stream: false, model: 'gpt-oss-120b', body })
      await p.dispatch(req, account, 'k')
      expect((capturedCtx as { systemPrompt?: string }).systemPrompt).toBe('be brief')
    } finally {
      restore()
    }
  })

  it('passes catalog Model when type=cerebras and id is in catalog', async () => {
    let capturedModel: unknown
    const { restore } = await stubCompletions((m, _ctx, _opts) => {
      capturedModel = m
      const ev = createAssistantMessageEventStream()
      pushDone(ev, 'gpt-oss-120b')
      return ev
    })
    try {
      const p = createOpenAICompletionsProvider(
        'cerebras',
        'cerebras',
        'https://api.cerebras.ai/v1'
      )
      const req = makeRequest({ format: 'openai', stream: false, model: 'gpt-oss-120b' })
      await p.dispatch(req, account, 'k')
      const m = capturedModel as { id: string; provider: string; cost: { input: number } }
      expect(m.id).toBe('gpt-oss-120b')
      expect(m.provider).toBe('cerebras')
      // Catalog cerebras model has a real cost, not zero
      expect(m.cost.input).toBeGreaterThan(0)
    } finally {
      restore()
    }
  })

  it('passes constructed Model with factory baseUrl when catalog misses', async () => {
    let capturedModel: unknown
    const { restore } = await stubCompletions((m, _ctx, _opts) => {
      capturedModel = m
      const ev = createAssistantMessageEventStream()
      pushDone(ev, 'meta/llama-3.1-8b-instruct')
      return ev
    })
    try {
      const p = createOpenAICompletionsProvider(
        'nvidia',
        'openai-compatible',
        'https://integrate.api.nvidia.com/v1'
      )
      const req = makeRequest({
        format: 'openai',
        stream: false,
        model: 'meta/llama-3.1-8b-instruct'
      })
      await p.dispatch(req, account, 'k')
      const m = capturedModel as {
        id: string
        provider: string
        baseUrl: string
        api: string
        cost: { input: number }
      }
      expect(m.id).toBe('meta/llama-3.1-8b-instruct')
      expect(m.baseUrl).toBe('https://integrate.api.nvidia.com/v1')
      expect(m.api).toBe('openai-completions')
      expect(m.cost.input).toBe(0)
    } finally {
      restore()
    }
  })

  it('caps maxTokens from body.max_tokens', async () => {
    let capturedOpts: unknown
    const { restore } = await stubCompletions((_m, _ctx, opts) => {
      capturedOpts = opts
      const ev = createAssistantMessageEventStream()
      pushDone(ev, 'gpt-oss-120b')
      return ev
    })
    try {
      const p = createOpenAICompletionsProvider(
        'cerebras',
        'cerebras',
        'https://api.cerebras.ai/v1'
      )
      const req = makeRequest({
        format: 'openai',
        stream: false,
        model: 'gpt-oss-120b',
        body: {
          model: 'gpt-oss-120b',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 4
        }
      })
      await p.dispatch(req, account, 'k')
      expect((capturedOpts as { maxTokens: number }).maxTokens).toBe(4)
    } finally {
      restore()
    }
  })

  it('passes maxRetries=3 and maxRetryDelayMs=30000 to pi-ai', async () => {
    let capturedOpts: unknown
    const { restore } = await stubCompletions((_m, _ctx, opts) => {
      capturedOpts = opts
      const ev = createAssistantMessageEventStream()
      pushDone(ev, 'meta/llama-3.1-8b-instruct')
      return ev
    })
    try {
      const p = createOpenAICompletionsProvider('nvidia', 'openai-compatible', 'https://x/v1')
      const req = makeRequest({ format: 'openai', stream: false })
      await p.dispatch(req, account, 'k')
      const o = capturedOpts as { maxRetries: number; maxRetryDelayMs: number }
      expect(o.maxRetries).toBe(3)
      expect(o.maxRetryDelayMs).toBe(30_000)
    } finally {
      restore()
    }
  })

  it('does not emit type:"input_text" in upstream OpenAI payload', async () => {
    const captured: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/chat/completions') && typeof init?.body === 'string') {
        captured.push(init.body)
      }
      const sse =
        'data: {"id":"x","object":"chat.completion.chunk","created":0,' +
        '"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":""},' +
        '"finish_reason":null}]}\n\n' +
        'data: {"id":"x","object":"chat.completion.chunk","created":0,' +
        '"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
        'data: [DONE]\n\n'
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    }) as typeof fetch

    try {
      const p = createOpenAICompletionsProvider(
        'nvidia',
        'openai-compatible',
        'https://example.test/v1'
      )
      const req = makeRequest({
        format: 'openai',
        stream: false,
        body: {
          model: 'meta/llama-3.1-8b-instruct',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'x' },
                { type: 'text', text: 'y' }
              ]
            }
          ],
          max_tokens: 8
        }
      })
      await p.dispatch(req, account, 'k')

      expect(captured.length).toBeGreaterThan(0)
      const body = captured[0]
      if (!body) throw new Error('missing captured body')
      expect(body).not.toContain('"type":"input_text"')

      const parsed = JSON.parse(body) as {
        messages: Array<{ role: string; content: unknown }>
      }
      const userMsg = parsed.messages.find((m) => m.role === 'user')
      expect(userMsg).toBeDefined()
      expect(Array.isArray(userMsg?.content)).toBe(true)
      if (!userMsg || !Array.isArray(userMsg.content)) throw new Error('missing user content')
      for (const part of userMsg.content as Array<{ type: string }>) {
        expect(part.type).toBe('text')
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('propagates client AbortSignal as opts.signal', async () => {
    let capturedOpts: unknown
    const { restore } = await stubCompletions((_m, _ctx, opts) => {
      capturedOpts = opts
      const ev = createAssistantMessageEventStream()
      pushDone(ev, 'meta/llama-3.1-8b-instruct')
      return ev
    })
    try {
      const p = createOpenAICompletionsProvider('nvidia', 'openai-compatible', 'https://x/v1')
      const req = makeRequest({ format: 'openai', stream: false })
      await p.dispatch(req, account, 'k')
      const o = capturedOpts as { apiKey: string; signal: unknown }
      expect(o.apiKey).toBe('k')
      expect(o.signal).toBeInstanceOf(AbortSignal)
    } finally {
      restore()
    }
  })
})
