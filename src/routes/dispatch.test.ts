// src/routes/dispatch.test.ts

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MutableModels } from '@earendil-works/pi-ai'
import { Hono } from 'hono'
import { timing } from 'hono/timing'
import { buildCatalog } from '../pipeline/catalog'
import { createState } from '../state'
import type { Env } from '../telemetry/hono-env'
import { createTel } from '../telemetry/tel'
import { useTestExporter } from '../telemetry/test-fixture'
import type { Account, Provider, ProviderEntry, RouterOptions } from '../types'
import { createDispatchHandler } from './dispatch'

const exporter = useTestExporter()

// Dispatch routes on pipeline-literal addresses and a mock registry, so the
// catalog needs no real provider catalogs — a Models stub with empty listings.
const stubModels = { getModels: () => [], getModel: () => undefined } as unknown as MutableModels

// Each request gets a root span via tel.withSpan('http.server.request', …) so
// provider_fallback / provider_error_final events have a parent to attach to,
// mirroring the @hono/otel middleware that wraps requests in production.
const mkApp = (
  options: RouterOptions,
  registry: Map<string, ProviderEntry>,
  authDir = '/tmp'
): Hono<Env> => {
  const catalog = buildCatalog(options, stubModels, authDir)
  const state = createState(options, catalog, stubModels, { accounts: {} }, authDir)
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

  test('an unauthenticated provider is gated with a login hint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'disp-'))
    const options: RouterOptions = {
      providers: {
        cc: { type: 'anthropic', account: { credential: 'oauth', name: 'anthropic-cc' } }
      },
      pipeline: [{ kind: 'alias', name: 'solo', target: 'cc/claude-opus-4-8' }],
      expose: []
    }
    const ccAccount: Account = { credential: 'oauth', name: 'anthropic-cc' }
    const ccProvider: Provider = {
      name: 'cc',
      type: 'anthropic',
      dispatch: async () => {
        throw new Error('should not be called: an unavailable provider must be gated first')
      }
    }
    const registry = new Map<string, ProviderEntry>([
      ['cc', { provider: ccProvider, account: ccAccount }]
    ])
    // authDir here filters `cc` out of the catalog (no credential file), but that
    // doesn't matter: `cc/claude-opus-4-8` is a literal alias target, and
    // resolveCandidates reads literal alias/pool targets straight from
    // opts.pipeline/entry.to (src/pipeline/resolve.ts:94-105) without ever
    // consulting catalog.addresses — only glob substitutions do that. So the
    // request reaches dispatch regardless of catalog filtering, and the runtime
    // gate below is the only thing standing between an unauthenticated provider
    // and an upstream call — not a redundant second check.
    const app = mkApp(options, registry, dir)
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'solo', messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(res.status).toBe(502)
    expect(await res.text()).toContain('pi-route provider login cc')
  })

  test('the gate reads the catalog snapshot, so a logout only lands at the next rebuild', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'disp-'))
    writeFileSync(join(dir, 'anthropic-cc.json'), '{}')
    const ccAccount: Account = { credential: 'oauth', name: 'anthropic-cc' }
    const options: RouterOptions = {
      providers: { cc: { type: 'anthropic', account: ccAccount } },
      pipeline: [{ kind: 'alias', name: 'solo', target: 'cc/claude-opus-4-8' }],
      expose: []
    }
    const ccProvider: Provider = {
      name: 'cc',
      type: 'anthropic',
      dispatch: async () => okResponse('cc', 'claude-opus-4-8')
    }
    const registry = new Map<string, ProviderEntry>([
      ['cc', { provider: ccProvider, account: ccAccount }]
    ])
    // The catalog is built here, while the credential still exists.
    const app = mkApp(options, registry, dir)
    // Now the credential disappears. The gate must NOT stat the file per request:
    // it serves the snapshot until the next catalog rebuild (boot / 4h refresh).
    rmSync(join(dir, 'anthropic-cc.json'))
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'solo', messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(res.status).toBe(200)
  })

  test('a failover pool skips an unavailable first member and succeeds via the second', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'disp-'))
    writeFileSync(join(dir, 'b.json'), '{}')

    const calls: string[] = []
    const gatedProvider: Provider = {
      name: 'a',
      type: 'anthropic',
      dispatch: async () => {
        calls.push('a')
        throw new Error('should not be called: unavailable provider must be gated first')
      }
    }
    const okProvider: Provider = {
      name: 'b',
      type: 'anthropic',
      dispatch: async () => {
        calls.push('b')
        return okResponse('b', 'x')
      }
    }

    const options: RouterOptions = {
      providers: {
        a: { type: 'anthropic', account: { credential: 'oauth', name: 'a' } },
        b: { type: 'anthropic', account: { credential: 'oauth', name: 'b' } }
      },
      pipeline: [{ kind: 'pool', name: 'gpt', to: ['a/x', 'b/x'], strategy: 'failover' }],
      expose: []
    }
    const registry = new Map<string, ProviderEntry>([
      ['a', { provider: gatedProvider, account: { credential: 'oauth', name: 'a' } }],
      ['b', { provider: okProvider, account: { credential: 'oauth', name: 'b' } }]
    ])

    // authDir only has b.json, so `a` fails isAvailable and never reaches
    // dispatch(); the request should still succeed through `b`.
    const app = mkApp(options, registry, dir)
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt/x', messages: [{ role: 'user', content: 'hi' }] })
    })

    expect(res.status).toBe(200)
    expect(calls).toEqual(['b'])
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
