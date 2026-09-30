import { describe, expect, it } from 'bun:test'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { PerTokenUsd } from '../pipeline/money'
import type { IncomingRequest } from '../types'
import { DispatchAuthError, UpstreamError } from './models-dispatch'
import { capMaxTokens, jsonResponse, makeMetadata, streamingResponse } from './pi-ai-runtime'

describe('capMaxTokens', () => {
  it('caps when body.max_tokens is below model.maxTokens', () => {
    const m = { id: 'x', maxTokens: 8192 } as { id: string; maxTokens: number }
    const result = capMaxTokens(m, { max_tokens: 16 })
    expect(result.maxTokens).toBe(16)
    expect(result.id).toBe('x') // preserves other fields
  })

  it('keeps model.maxTokens when body.max_tokens exceeds it or is invalid', () => {
    const m = { maxTokens: 100 } as { maxTokens: number }
    expect(capMaxTokens(m, { max_tokens: 999 }).maxTokens).toBe(100)
    expect(capMaxTokens(m, { max_tokens: NaN }).maxTokens).toBe(100)
    expect(capMaxTokens(m, { max_tokens: 0 }).maxTokens).toBe(100)
    expect(capMaxTokens(m, { max_tokens: -1 }).maxTokens).toBe(100)
  })

  it('passes model unchanged when body.max_tokens is absent', () => {
    const m = { maxTokens: 4096 } as { maxTokens: number }
    const result = capMaxTokens(m, {})
    expect(result.maxTokens).toBe(4096)
  })

  it('caps max output tokens from max_output_tokens field (Responses-API name)', () => {
    const model = { maxTokens: 1000 }
    const capped = capMaxTokens(model, { max_output_tokens: 16 })
    expect(capped.maxTokens).toBe(16)
  })

  it('prefers max_tokens over max_output_tokens when both present', () => {
    const model = { maxTokens: 1000 }
    const capped = capMaxTokens(model, { max_tokens: 32, max_output_tokens: 16 })
    expect(capped.maxTokens).toBe(32)
  })
})

describe('makeMetadata', () => {
  const baseRequest = {
    id: 'req-1',
    format: 'anthropic',
    rawRequest: new Request('http://x'),
    model: 'mdl-1',
    stream: false
  } as IncomingRequest

  it('builds metadata from the request and provider name', () => {
    const start = Date.now() - 250
    const m = makeMetadata(baseRequest, 'prov-1', start)
    expect(m.requestId).toBe('req-1')
    expect(m.provider).toBe('prov-1')
    expect(m.model).toBe('mdl-1')
    expect(m.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('does not set an account field', () => {
    const m = makeMetadata(baseRequest, 'prov-1', Date.now())
    expect('account' in m).toBe(false)
  })
})

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

const pushError = (
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  errorMessage = 'upstream blew up'
) =>
  queueMicrotask(() => {
    stream.push({
      type: 'error',
      reason: 'error',
      error: {
        role: 'assistant',
        content: [],
        api: 'openai-completions',
        provider: 'test',
        model: 'm-1',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: 'error',
        errorMessage,
        timestamp: Date.now()
      }
    })
  })

const meta = {
  requestId: 'r-1',
  provider: 'p-1',
  model: 'm-1',
  latencyMs: 1
}

const makeReq = (format: 'anthropic' | 'openai' | 'responses'): IncomingRequest => ({
  id: 'r-1',
  format,
  rawRequest: new Request('http://x'),
  model: 'm-1',
  stream: true
})

const ctx = { costs: { inputCost: 0 as PerTokenUsd, outputCost: 0 as PerTokenUsd } }

describe('streamingResponse', () => {
  const partial: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'test',
    model: 'm-1',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp: 1
  }

  it('returns SSE headers + ReadableStream body for both formats', async () => {
    const evA = createAssistantMessageEventStream()
    pushDone(evA, 'm-1')
    const rA = await streamingResponse(evA, makeReq('anthropic'), meta, ctx)
    expect(rA.status).toBe(200)
    expect(rA.headers.get('content-type')).toBe('text/event-stream')
    expect(rA.body instanceof ReadableStream).toBe(true)

    const evO = createAssistantMessageEventStream()
    pushDone(evO, 'm-1')
    const rO = await streamingResponse(evO, makeReq('openai'), meta, ctx)
    expect(rO.headers.get('content-type')).toBe('text/event-stream')
    expect(rO.body instanceof ReadableStream).toBe(true)
  })

  const readAll = async (body: unknown): Promise<string> =>
    new Response(body as ReadableStream).text()

  it('throws before committing when the stream opens with an error', async () => {
    const ev = createAssistantMessageEventStream()
    pushError(ev, '402 status code (no body)')
    const err = await streamingResponse(ev, makeReq('openai'), meta, ctx).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UpstreamError)
    expect((err as UpstreamError).status).toBe(402)
  })

  it('throws when an error follows start but precedes content', async () => {
    const ev = createAssistantMessageEventStream()
    queueMicrotask(() => ev.push({ type: 'start', partial }))
    pushError(ev, '429 status code (no body)')
    const err = await streamingResponse(ev, makeReq('openai'), meta, ctx).catch((e: unknown) => e)
    expect((err as UpstreamError).status).toBe(429)
  })

  it('throws when an error follows start and text_start', async () => {
    const ev = createAssistantMessageEventStream()
    queueMicrotask(() => {
      ev.push({ type: 'start', partial })
      ev.push({ type: 'text_start', contentIndex: 0, partial })
    })
    pushError(ev, '503 status code (no body)')
    const err = await streamingResponse(ev, makeReq('openai'), meta, ctx).catch((e: unknown) => e)
    expect((err as UpstreamError).status).toBe(503)
  })

  it('commits when the stream opens with done', async () => {
    const ev = createAssistantMessageEventStream()
    pushDone(ev, 'm-1')
    const r = await streamingResponse(ev, makeReq('responses'), meta, ctx)
    const text = await readAll(r.body)
    expect(text).toContain('event: response.completed')
    expect(text).toContain('"text":"hello"')
  })

  it('commits on toolcall_start, leaving a later error in-band', async () => {
    const ev = createAssistantMessageEventStream()
    const withCall: AssistantMessage = {
      ...partial,
      content: [{ type: 'toolCall', id: 'call-1', name: 'lookup', arguments: {} }]
    }
    queueMicrotask(() => ev.push({ type: 'toolcall_start', contentIndex: 0, partial: withCall }))
    pushError(ev)
    const r = await streamingResponse(ev, makeReq('openai'), meta, ctx)
    expect(await readAll(r.body)).toContain('"name":"lookup"')
  })

  it('maps an OAuth refresh failure before content to DispatchAuthError', async () => {
    const ev = createAssistantMessageEventStream()
    pushError(ev, 'OAuth refresh failed: token revoked')
    const err = await streamingResponse(ev, makeReq('openai'), meta, ctx).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DispatchAuthError)
  })

  it('replays held events in order once content starts', async () => {
    const ev = createAssistantMessageEventStream()
    queueMicrotask(() => {
      ev.push({ type: 'start', partial })
      ev.push({ type: 'text_start', contentIndex: 0, partial })
      ev.push({ type: 'text_delta', contentIndex: 0, delta: 'PO', partial })
      ev.push({ type: 'text_delta', contentIndex: 0, delta: 'NG', partial })
    })
    pushDone(ev, 'm-1')
    const r = await streamingResponse(ev, makeReq('openai'), meta, ctx)
    const text = await readAll(r.body)
    expect(text).toContain('"role":"assistant"')
    expect(text.indexOf('"role":"assistant"')).toBeLessThan(text.indexOf('"content":"PO"'))
    expect(text.indexOf('"content":"PO"')).toBeLessThan(text.indexOf('"content":"NG"'))
  })

  it('throws when the stream ends with no event at all', async () => {
    const ev = createAssistantMessageEventStream()
    queueMicrotask(() => ev.end())
    await expect(streamingResponse(ev, makeReq('openai'), meta, ctx)).rejects.toThrow('No response')
  })
})

describe('jsonResponse', () => {
  it('returns anthropic-shaped body on done event for anthropic format', async () => {
    const ev = createAssistantMessageEventStream()
    pushDone(ev, 'm-1')
    const r = await jsonResponse(ev, makeReq('anthropic'), meta, ctx)
    expect(r.headers.get('content-type')).toBe('application/json')
    const body = r.body as Record<string, unknown>
    expect(Array.isArray(body.content)).toBe(true)
    expect((body.content as Record<string, unknown>[])[0]?.type).toBe('text')
    expect(body.choices).toBeUndefined()
  })

  it('returns openai-shaped body on done event for openai format', async () => {
    const ev = createAssistantMessageEventStream()
    pushDone(ev, 'm-1')
    const r = await jsonResponse(ev, makeReq('openai'), meta, ctx)
    const body = r.body as Record<string, unknown>
    expect(Array.isArray(body.choices)).toBe(true)
    expect(body.content).toBeUndefined()
  })

  it('throws with errorMessage on error event', async () => {
    const ev = createAssistantMessageEventStream()
    pushError(ev)
    await expect(jsonResponse(ev, makeReq('openai'), meta, ctx)).rejects.toThrow('upstream blew up')
  })

  it('throws when stream ends without a done event', async () => {
    const ev = createAssistantMessageEventStream()
    queueMicrotask(() => ev.end())
    await expect(jsonResponse(ev, makeReq('openai'), meta, ctx)).rejects.toThrow('No response')
  })

  it('throws an UpstreamError carrying the status pi-ai put in the message', async () => {
    const ev = createAssistantMessageEventStream()
    pushError(ev, '402 status code (no body)')
    const err = await jsonResponse(ev, makeReq('openai'), meta, ctx).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UpstreamError)
    expect((err as UpstreamError).status).toBe(402)
    expect((err as UpstreamError).message).toBe('402 status code (no body)')
  })

  it('leaves the status undefined when the message names none', async () => {
    const ev = createAssistantMessageEventStream()
    pushError(ev)
    const err = await jsonResponse(ev, makeReq('openai'), meta, ctx).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UpstreamError)
    expect((err as UpstreamError).status).toBeUndefined()
  })
})
