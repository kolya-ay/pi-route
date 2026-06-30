// src/routes/dispatch.test.ts

import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { timing } from 'hono/timing'
import { buildCatalog } from '../pipeline/catalog'
import type { ProviderEntry } from '../providers/registry'
import { createState } from '../state'
import type { Env } from '../telemetry/hono-env'
import { createTel } from '../telemetry/tel'
import { useTestExporter } from '../telemetry/test-fixture'
import type { Account, Provider, RouterOptions } from '../types'
import { createDispatchHandler } from './dispatch'

const exporter = useTestExporter()

// Each request gets a root span via tel.withSpan('http.server.request', …) so
// provider_fallback / provider_error_final events have a parent to attach to,
// mirroring the @hono/otel middleware that wraps requests in production.
const mkApp = (options: RouterOptions, registry: Map<string, ProviderEntry>): Hono<Env> => {
  const catalog = buildCatalog(options)
  const state = createState(options, catalog, { accounts: {} }, '/tmp')
  const tel = createTel()
  const app = new Hono<Env>()
  app.use('*', timing())
  app.use('*', async (c, next) => {
    c.set('requestId', 'test-req-1')
    c.set('tel', tel)
    c.set('state', state)
    await tel.withSpan('http.server.request', {}, async () => {
      await next()
    })
  })
  app.post(
    '/v1/chat/completions',
    createDispatchHandler({
      format: 'openai',
      registry
    })
  )
  return app
}

const okResponse = (provider: string, model: string) => ({
  status: 200,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: { id: 'r1', choices: [{ message: { content: 'hi' } }] } as Record<string, unknown>,
  metadata: { requestId: 'test-req-1', provider, model, latencyMs: 1 }
})

const keyAccount: Account = { credential: 'key', key: 'k' }

describe('dispatch failover', () => {
  test('falls over to second member when first throws; emits provider_fallback', async () => {
    const calls: string[] = []

    const failingProvider: Provider = {
      name: 'a',
      type: 'openai-compatible',
      dispatch: async () => {
        calls.push('a')
        throw new Error('boom')
      }
    }
    const okProvider: Provider = {
      name: 'b',
      type: 'openai-compatible',
      dispatch: async () => {
        calls.push('b')
        return okResponse('b', 'x')
      }
    }

    const options: RouterOptions = {
      providers: {
        a: { type: 'openai-compatible', account: keyAccount },
        b: { type: 'openai-compatible', account: keyAccount }
      },
      pipeline: [{ kind: 'pool', name: 'gpt', to: ['a/x', 'b/x'], strategy: 'failover' }],
      expose: []
    }
    const registry = new Map<string, ProviderEntry>([
      ['a', { provider: failingProvider, account: keyAccount }],
      ['b', { provider: okProvider, account: keyAccount }]
    ])

    const app = mkApp(options, registry)
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt/x', messages: [{ role: 'user', content: 'hi' }] })
    })

    expect(res.status).toBe(200)
    expect(calls).toEqual(['a', 'b'])

    const spans = exporter.getFinishedSpans()
    const root = spans.find((s) => s.name === 'http.server.request')
    expect(root).toBeDefined()
    const fb = root?.events.find((e) => e.name === 'provider_fallback')
    expect(fb).toBeDefined()
    expect(fb?.attributes?.['pi.from']).toBe('a/x')
    expect(fb?.attributes?.['pi.to']).toBe('b/x')
    expect(String(fb?.attributes?.['pi.reason'] ?? '')).toContain('boom')

    const attempts = spans.filter((s) => s.name === 'gen_ai.dispatch_attempt')
    expect(attempts.length).toBe(2)
    expect(attempts[0]?.attributes['gen_ai.provider.name']).toBe('a')
    expect(attempts[1]?.attributes['gen_ai.provider.name']).toBe('b')

    const errEvent = attempts[0]?.events.find((e) => e.name === 'provider_error')
    expect(errEvent).toBeDefined()
    expect(String(errEvent?.attributes?.['error.message'] ?? '')).toContain('boom')
  })

  test('all members fail → 502 + provider_error_final with last message; one fallback hop', async () => {
    const failA: Provider = {
      name: 'a',
      type: 'openai-compatible',
      dispatch: async () => {
        throw new Error('first-fail')
      }
    }
    const failB: Provider = {
      name: 'b',
      type: 'openai-compatible',
      dispatch: async () => {
        throw new Error('second-fail')
      }
    }

    const options: RouterOptions = {
      providers: {
        a: { type: 'openai-compatible', account: keyAccount },
        b: { type: 'openai-compatible', account: keyAccount }
      },
      pipeline: [{ kind: 'pool', name: 'gpt', to: ['a/x', 'b/x'], strategy: 'failover' }],
      expose: []
    }
    const registry = new Map<string, ProviderEntry>([
      ['a', { provider: failA, account: keyAccount }],
      ['b', { provider: failB, account: keyAccount }]
    ])

    const app = mkApp(options, registry)
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt/x', messages: [{ role: 'user', content: 'hi' }] })
    })

    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('second-fail')

    const spans = exporter.getFinishedSpans()
    const root = spans.find((s) => s.name === 'http.server.request')
    const finalErr = root?.events.find((e) => e.name === 'provider_error_final')
    expect(finalErr).toBeDefined()
    expect(String(finalErr?.attributes?.['error.message'] ?? '')).toContain('second-fail')
    const hops = root?.events.filter((e) => e.name === 'provider_fallback') ?? []
    expect(hops).toHaveLength(1)
  })
})

describe('dispatch capture wire-up', () => {
  const captureProvider = (calls: Array<{ telHooks: unknown }>): Provider => ({
    name: 'a',
    type: 'openai-compatible',
    dispatch: async (request) => {
      calls.push({ telHooks: request.telHooks })
      return okResponse('a', 'x')
    }
  })

  const baseOptions: RouterOptions = {
    providers: { a: { type: 'openai-compatible', account: keyAccount } },
    pipeline: [{ kind: 'pool', name: 'gpt', to: ['a/x'], strategy: 'failover' }],
    expose: []
  }

  test('when PI_ROUTE_CAPTURE_PROMPTS=1, dispatch_attempt span carries gen_ai.input.messages', async () => {
    const prev = process.env.PI_ROUTE_CAPTURE_PROMPTS
    process.env.PI_ROUTE_CAPTURE_PROMPTS = '1'
    try {
      const calls: Array<{ telHooks: unknown }> = []
      const registry = new Map<string, ProviderEntry>([
        ['a', { provider: captureProvider(calls), account: keyAccount }]
      ])
      const app = mkApp(baseOptions, registry)
      const messages = [{ role: 'user', content: 'capture-me-please' }]
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt/x', messages, system: 'sys-1', tools: [{ name: 't' }] })
      })
      expect(res.status).toBe(200)
      // Provider received telHooks (so wrapStreamForMetrics can fire on pi-ai
      // streams; here we just verify the plumbing).
      expect(calls[0]?.telHooks).toBeDefined()

      const spans = exporter.getFinishedSpans()
      const attempt = spans.find((s) => s.name === 'gen_ai.dispatch_attempt')
      expect(attempt).toBeDefined()
      expect(attempt?.attributes['gen_ai.input.messages']).toContain('capture-me-please')
      expect(attempt?.attributes['gen_ai.system_instructions']).toBe('sys-1')
      expect(attempt?.attributes['gen_ai.tool.definitions']).toContain('"name":"t"')
    } finally {
      if (prev === undefined) delete process.env.PI_ROUTE_CAPTURE_PROMPTS
      else process.env.PI_ROUTE_CAPTURE_PROMPTS = prev
    }
  })

  test('streaming response keeps the dispatch_attempt span open until upstream stream ends', async () => {
    // Verifies the tee+await-completion plumbing in dispatch.ts: a streaming
    // provider that writes attrs LATE (mimicking wrapStreamForMetrics' done-event
    // path) should still land its setAttribute calls on the live attempt span.
    const lateAttrProvider: Provider = {
      name: 'a',
      type: 'openai-compatible',
      dispatch: async (request) => {
        const span = request.telHooks?.span
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise<void>((r) => setTimeout(r, 5))
            controller.enqueue(new TextEncoder().encode('data: chunk\n\n'))
            // Simulate the wrapper recording metrics on the done event AFTER
            // the response object has been returned to dispatch.
            span?.setAttribute('pi.output_tokens_per_second', 42)
            controller.close()
          }
        })
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'text/event-stream' }),
          body,
          metadata: { requestId: request.id, provider: 'a', model: request.model, latencyMs: 1 }
        }
      }
    }
    const options: RouterOptions = {
      providers: { a: { type: 'openai-compatible', account: keyAccount } },
      pipeline: [{ kind: 'pool', name: 'gpt', to: ['a/x'], strategy: 'failover' }],
      expose: []
    }
    const registry = new Map<string, ProviderEntry>([
      ['a', { provider: lateAttrProvider, account: keyAccount }]
    ])
    const app = mkApp(options, registry)
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt/x', stream: true, messages: [] })
    })
    expect(res.status).toBe(200)
    // Consume the body so completion can settle before assertions.
    await res.text()
    const attempt = exporter.getFinishedSpans().find((s) => s.name === 'gen_ai.dispatch_attempt')
    expect(attempt).toBeDefined()
    expect(attempt?.attributes['pi.output_tokens_per_second']).toBe(42)
  })

  test('when PI_ROUTE_CAPTURE_PROMPTS is unset, dispatch_attempt span has no capture attrs', async () => {
    const prev = process.env.PI_ROUTE_CAPTURE_PROMPTS
    delete process.env.PI_ROUTE_CAPTURE_PROMPTS
    try {
      const calls: Array<{ telHooks: unknown }> = []
      const registry = new Map<string, ProviderEntry>([
        ['a', { provider: captureProvider(calls), account: keyAccount }]
      ])
      const app = mkApp(baseOptions, registry)
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt/x',
          messages: [{ role: 'user', content: 'should-not-be-captured' }]
        })
      })
      expect(res.status).toBe(200)
      // telHooks is still threaded (needed for stream wrapping) but capture flag is off.
      expect(calls[0]?.telHooks).toBeDefined()
      const attempt = exporter.getFinishedSpans().find((s) => s.name === 'gen_ai.dispatch_attempt')
      expect(attempt?.attributes['gen_ai.input.messages']).toBeUndefined()
    } finally {
      if (prev !== undefined) process.env.PI_ROUTE_CAPTURE_PROMPTS = prev
    }
  })
})
