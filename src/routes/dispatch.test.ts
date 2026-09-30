// src/routes/dispatch.test.ts

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Api, AssistantMessage, Model, MutableModels, ToolCall } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { Span } from '@opentelemetry/api'
import { Hono } from 'hono'
import { timing } from 'hono/timing'
import { buildCatalog } from '../pipeline/catalog'
import {
  createModelsDispatch,
  DispatchAuthError,
  ModelNotOfferedError
} from '../providers/models-dispatch'
import { createState } from '../state'
import { STRUCTURED_OUTPUT_TOOL } from '../structured-output'
import type { Env } from '../telemetry/hono-env'
import { createTel } from '../telemetry/tel'
import { useTestExporter } from '../telemetry/test-fixture'
import type { Account, Provider, ProviderEntry, RouterOptions } from '../types'
import { createDispatchHandler, endOnSettle } from './dispatch'

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
  authDir = '/tmp',
  format: 'openai' | 'responses' | 'anthropic' = 'openai'
): Hono<Env> => {
  const catalog = buildCatalog(options, stubModels, authDir, new Map())
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
    { openai: '/v1/chat/completions', responses: '/v1/responses', anthropic: '/v1/messages' }[
      format
    ],
    createDispatchHandler({ format, registry })
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

const post = (
  app: Hono<Env>,
  path: string,
  body: Record<string, unknown>,
  init: RequestInit = {}
) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init
  })

const stubModel = ({ api = 'openai-completions', provider = 'a' } = {}): Model<Api> =>
  ({
    id: 'x',
    name: 'X',
    api,
    provider,
    baseUrl: 'http://x',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 500
  }) as Model<Api>

const message = (provider: string, extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: 'assistant',
  content: [],
  api: 'openai-completions',
  provider,
  model: 'x',
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  },
  stopReason: 'stop',
  timestamp: 1,
  ...extra
})

// A failover pool `default` over `<name>/x` for each member.
const poolApp = (
  members: [string, Provider][],
  format: 'openai' | 'responses' | 'anthropic' = 'openai'
): Hono<Env> =>
  mkApp(
    {
      providers: Object.fromEntries(
        members.map(([name]) => [
          name,
          { type: 'openai-compatible', account: keyAccount, formatTranslation: 'auto' }
        ])
      ),
      pipeline: [
        {
          kind: 'pool',
          name: 'default',
          to: members.map(([name]) => `${name}/x`),
          strategy: 'failover'
        }
      ],
      expose: []
    },
    new Map(members.map(([name, provider]) => [name, { provider, account: keyAccount }])),
    '/tmp',
    format
  )

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
        a: { type: 'openai-compatible', account: keyAccount, formatTranslation: 'auto' },
        b: { type: 'openai-compatible', account: keyAccount, formatTranslation: 'auto' }
      },
      pipeline: [{ kind: 'pool', name: 'gpt', to: ['a/x', 'b/x'], strategy: 'failover' }],
      expose: []
    }
    const registry = new Map<string, ProviderEntry>([
      ['a', { provider: failingProvider, account: keyAccount }],
      ['b', { provider: okProvider, account: keyAccount }]
    ])

    const app = mkApp(options, registry)
    const res = await post(app, '/v1/chat/completions', {
      model: 'gpt/x',
      messages: [{ role: 'user', content: 'hi' }]
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

  test('all members fail → 502 + provider_error_final naming every attempt; one fallback hop', async () => {
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
        a: { type: 'openai-compatible', account: keyAccount, formatTranslation: 'auto' },
        b: { type: 'openai-compatible', account: keyAccount, formatTranslation: 'auto' }
      },
      pipeline: [{ kind: 'pool', name: 'gpt', to: ['a/x', 'b/x'], strategy: 'failover' }],
      expose: []
    }
    const registry = new Map<string, ProviderEntry>([
      ['a', { provider: failA, account: keyAccount }],
      ['b', { provider: failB, account: keyAccount }]
    ])

    const app = mkApp(options, registry)
    const res = await post(app, '/v1/chat/completions', {
      model: 'gpt/x',
      messages: [{ role: 'user', content: 'hi' }]
    })

    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain('first-fail')
    expect(body.error.message).toContain('second-fail')

    const spans = exporter.getFinishedSpans()
    const root = spans.find((s) => s.name === 'http.server.request')
    const finalErr = root?.events.find((e) => e.name === 'provider_error_final')
    expect(finalErr).toBeDefined()
    expect(String(finalErr?.attributes?.['error.message'] ?? '')).toContain('first-fail')
    expect(String(finalErr?.attributes?.['error.message'] ?? '')).toContain('second-fail')
    const hops = root?.events.filter((e) => e.name === 'provider_fallback') ?? []
    expect(hops).toHaveLength(1)
  })

  test('a model the upstream does not offer answers 404, not 502', async () => {
    const gone: Provider = {
      name: 'a',
      type: 'openai-compatible',
      dispatch: async () => {
        throw new ModelNotOfferedError('a', 'x')
      }
    }
    const options: RouterOptions = {
      providers: {
        a: { type: 'openai-compatible', account: keyAccount, formatTranslation: 'auto' }
      },
      pipeline: [{ kind: 'pool', name: 'gpt', to: ['a/x'], strategy: 'failover' }],
      expose: []
    }
    const registry = new Map<string, ProviderEntry>([
      ['a', { provider: gone, account: keyAccount }]
    ])

    const res = await post(mkApp(options, registry), '/v1/chat/completions', {
      model: 'gpt/x',
      messages: [{ role: 'user', content: 'hi' }]
    })

    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain('a does not offer "x"')
  })

  test('an unauthenticated provider is gated with a login hint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'disp-'))
    const options: RouterOptions = {
      providers: {
        cc: {
          type: 'anthropic',
          account: { credential: 'oauth', name: 'anthropic-cc' },
          formatTranslation: 'auto'
        }
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
    const res = await post(app, '/v1/chat/completions', {
      model: 'solo',
      messages: [{ role: 'user', content: 'hi' }]
    })
    expect(res.status).toBe(502)
    expect(await res.text()).toContain('pi-route provider login cc')
  })

  test('the gate reads the catalog snapshot, so a logout only lands at the next rebuild', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'disp-'))
    writeFileSync(join(dir, 'anthropic-cc.json'), '{}')
    const ccAccount: Account = { credential: 'oauth', name: 'anthropic-cc' }
    const options: RouterOptions = {
      providers: { cc: { type: 'anthropic', account: ccAccount, formatTranslation: 'auto' } },
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
    const res = await post(app, '/v1/chat/completions', {
      model: 'solo',
      messages: [{ role: 'user', content: 'hi' }]
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
        a: {
          type: 'anthropic',
          account: { credential: 'oauth', name: 'a' },
          formatTranslation: 'auto'
        },
        b: {
          type: 'anthropic',
          account: { credential: 'oauth', name: 'b' },
          formatTranslation: 'auto'
        }
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
    const res = await post(app, '/v1/chat/completions', {
      model: 'gpt/x',
      messages: [{ role: 'user', content: 'hi' }]
    })

    expect(res.status).toBe(200)
    expect(calls).toEqual(['b'])
  })

  test('a client that aborted is not failed over to the next member', async () => {
    const ac = new AbortController()
    const calls: string[] = []
    const aborting: Provider = {
      name: 'a',
      type: 'openai-compatible',
      dispatch: async () => {
        calls.push('a')
        ac.abort()
        throw new Error('aborted')
      }
    }
    const second: Provider = {
      name: 'b',
      type: 'openai-compatible',
      dispatch: async () => {
        calls.push('b')
        return okResponse('b', 'x')
      }
    }
    const app = poolApp([
      ['a', aborting],
      ['b', second]
    ])
    const lines: string[] = []
    const original = console.warn
    console.warn = (line: string) => {
      lines.push(line)
    }
    try {
      await post(
        app,
        '/v1/chat/completions',
        { model: 'default/x', messages: [] },
        { signal: ac.signal }
      )
    } finally {
      console.warn = original
    }
    expect(calls).toEqual(['a'])
    expect(lines.filter((l) => l.startsWith('[failover]'))).toEqual([])
    const root = exporter.getFinishedSpans().find((s) => s.name === 'http.server.request')
    expect(root?.events.some((e) => e.name === 'provider_fallback')).toBe(false)
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
    providers: { a: { type: 'openai-compatible', account: keyAccount, formatTranslation: 'auto' } },
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
      const res = await post(app, '/v1/chat/completions', {
        model: 'gpt/x',
        messages,
        system: 'sys-1',
        tools: [{ name: 't' }]
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
    // Verifies endOnSettle in dispatch.ts: a streaming provider that writes attrs
    // LATE (mimicking wrapStreamForMetrics' done-event path) should still land its
    // setAttribute calls on the live attempt span.
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
      providers: {
        a: { type: 'openai-compatible', account: keyAccount, formatTranslation: 'auto' }
      },
      pipeline: [{ kind: 'pool', name: 'gpt', to: ['a/x'], strategy: 'failover' }],
      expose: []
    }
    const registry = new Map<string, ProviderEntry>([
      ['a', { provider: lateAttrProvider, account: keyAccount }]
    ])
    const app = mkApp(options, registry)
    const res = await post(app, '/v1/chat/completions', {
      model: 'gpt/x',
      stream: true,
      messages: []
    })
    expect(res.status).toBe(200)
    // Consume the body so completion can settle before assertions.
    await res.text()
    const attempt = exporter.getFinishedSpans().find((s) => s.name === 'gen_ai.dispatch_attempt')
    expect(attempt).toBeDefined()
    expect(attempt?.attributes['pi.output_tokens_per_second']).toBe(42)
  })

  const sseProvider = (
    pull: (c: ReadableStreamDefaultController<Uint8Array>) => Promise<void>,
    cancel?: () => void
  ): Provider => ({
    name: 'a',
    type: 'openai-compatible',
    dispatch: async (request) => ({
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: new ReadableStream<Uint8Array>({ pull, ...(cancel ? { cancel } : {}) }),
      metadata: { requestId: request.id, provider: 'a', model: request.model, latencyMs: 1 }
    })
  })

  const streamRequest = (provider: Provider) =>
    post(poolApp([['a', provider]]), '/v1/chat/completions', {
      model: 'default/x',
      stream: true,
      messages: []
    })

  test('the first chunk reaches the client before the upstream finishes', async () => {
    const gap = 400
    let n = 0
    const provider = sseProvider(async (c) => {
      if (n > 0) await Bun.sleep(gap)
      c.enqueue(new TextEncoder().encode(`data: ${n}\n\n`))
      n += 1
      if (n === 4) c.close()
    })
    const start = Date.now()
    const res = await streamRequest(provider)
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    expect(Date.now() - start).toBeLessThan(gap / 2)
    await reader.cancel()
  })

  test('a client that walks away ends the attempt span and cancels the upstream', async () => {
    let cancelled = false
    const provider = sseProvider(
      async (c) => {
        await Bun.sleep(20)
        c.enqueue(new TextEncoder().encode('data: x\n\n'))
      },
      () => {
        cancelled = true
      }
    )
    const res = await streamRequest(provider)
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    await reader.cancel()
    await Bun.sleep(100)
    expect(cancelled).toBe(true)
    const attempt = exporter.getFinishedSpans().find((s) => s.name === 'gen_ai.dispatch_attempt')
    expect(attempt?.events.some((e) => e.name === 'stream_aborted')).toBe(true)
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
      const res = await post(app, '/v1/chat/completions', {
        model: 'gpt/x',
        messages: [{ role: 'user', content: 'should-not-be-captured' }]
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

describe('dispatch structured output', () => {
  const schema = {
    type: 'object',
    properties: { capital: { type: 'string' } },
    required: ['capital'],
    additionalProperties: false
  }

  const options: RouterOptions = {
    providers: { a: { type: 'openai-compatible', account: keyAccount, formatTranslation: 'auto' } },
    pipeline: [{ kind: 'pool', name: 'gpt', to: ['a/x'], strategy: 'failover' }],
    expose: []
  }

  const capturingApp = (seen: unknown[], format: 'openai' | 'responses' = 'openai'): Hono<Env> => {
    const provider: Provider = {
      name: 'a',
      type: 'openai-compatible',
      dispatch: async (request) => {
        seen.push(request.structuredOutput)
        return okResponse('a', 'x')
      }
    }
    const registry = new Map<string, ProviderEntry>([['a', { provider, account: keyAccount }]])
    return mkApp(options, registry, '/tmp', format)
  }

  test('hands providers the same constraint for both inbound syntaxes', async () => {
    const chatSeen: unknown[] = []
    const chatRes = await post(capturingApp(chatSeen), '/v1/chat/completions', {
      model: 'gpt/x',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'capital', strict: true, schema }
      }
    })
    const responsesSeen: unknown[] = []
    const responsesRes = await post(capturingApp(responsesSeen, 'responses'), '/v1/responses', {
      model: 'gpt/x',
      input: 'hi',
      text: { format: { type: 'json_schema', name: 'capital', schema } }
    })

    expect(chatRes.status).toBe(200)
    expect(responsesRes.status).toBe(200)
    expect(chatSeen[0]).toEqual({ name: 'capital', schema })
    expect(responsesSeen[0]).toEqual(chatSeen[0])
  })

  test('leaves structuredOutput undefined for ordinary requests', async () => {
    const seen: unknown[] = []
    const res = await post(capturingApp(seen), '/v1/chat/completions', {
      model: 'gpt/x',
      messages: [{ role: 'user', content: 'hi' }]
    })
    expect(res.status).toBe(200)
    expect(seen[0]).toBeUndefined()
  })

  test('rejects an unenforceable or conflicting schema with 400 before dispatch', async () => {
    const cases: [string, Record<string, unknown>][] = [
      [
        '/v1/chat/completions',
        { model: 'gpt/x', messages: [], response_format: { type: 'json_object' } }
      ],
      [
        '/v1/responses',
        { model: 'gpt/x', input: 'hi', text: { format: { type: 'json_schema', schema } } }
      ],
      [
        '/v1/chat/completions',
        {
          model: 'gpt/x',
          messages: [],
          tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
          response_format: { type: 'json_schema', json_schema: { name: 'capital', schema } }
        }
      ]
    ]

    for (const [path, body] of cases) {
      const seen: unknown[] = []
      const app = capturingApp(seen, path === '/v1/responses' ? 'responses' : 'openai')
      const res = await post(app, path, body)
      expect(res.status).toBe(400)
      expect((await res.json()) as { error: { message: string } }).toHaveProperty('error.message')
      expect(seen).toHaveLength(0)
    }
  })

  test('answers 400 rather than a routing failure when the model is unknown', async () => {
    const seen: unknown[] = []
    const res = await post(capturingApp(seen), '/v1/chat/completions', {
      model: 'no-such-route',
      messages: [],
      response_format: { type: 'json_schema', json_schema: { name: 'capital' } }
    })
    expect(res.status).toBe(400)
    expect(seen).toHaveLength(0)
  })
})

describe('structured output response contracts', () => {
  const schema = {
    type: 'object',
    properties: { capital: { type: 'string' } },
    required: ['capital'],
    additionalProperties: false
  }
  const document = '{"capital":"Paris"}'

  // A constrained-tool backend: the schema answer arrives as private tool arguments,
  // which pi-route must republish as ordinary assistant text.
  const toolCallModels = (api = 'anthropic-messages'): MutableModels => {
    const toolCall: ToolCall = {
      type: 'toolCall',
      id: 'call-1',
      name: STRUCTURED_OUTPUT_TOOL,
      arguments: { capital: 'Paris' }
    }
    const done = message('a', {
      api: 'anthropic-messages',
      content: [toolCall],
      stopReason: 'toolUse'
    })
    return {
      getModel: () => stubModel({ api }),
      stream: () => {
        const events = createAssistantMessageEventStream()
        events.push({ type: 'start', partial: done })
        events.push({ type: 'toolcall_start', contentIndex: 0, partial: done })
        events.push({ type: 'toolcall_delta', contentIndex: 0, delta: document, partial: done })
        events.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial: done })
        events.push({ type: 'done', reason: 'toolUse', message: done })
        events.end(done)
        return events
      }
    } as unknown as MutableModels
  }

  const modelsApp = (
    models: MutableModels,
    format: 'openai' | 'responses',
    extra: [string, Provider][] = []
  ): Hono<Env> => poolApp([['a', createModelsDispatch(models, 'a')], ...extra], format)

  const request = (app: Hono<Env>, format: 'openai' | 'responses', stream: boolean) =>
    format === 'openai'
      ? post(app, '/v1/chat/completions', {
          model: 'default/x',
          stream,
          messages: [{ role: 'user', content: 'hi' }],
          response_format: { type: 'json_schema', json_schema: { name: 'capital', schema } }
        })
      : post(app, '/v1/responses', {
          model: 'default/x',
          stream,
          input: 'hi',
          text: { format: { type: 'json_schema', name: 'capital', schema } }
        })

  const sseFrames = (raw: string): Record<string, unknown>[] =>
    raw
      .split('\n')
      .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)

  test('chat returns the JSON document as message content', async () => {
    const res = await request(modelsApp(toolCallModels(), 'openai'), 'openai', false)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      choices: [{ message: { content: string; tool_calls?: unknown }; finish_reason: string }]
    }
    expect(body.choices[0].message.content).toBe(document)
    expect(body.choices[0].message.tool_calls).toBeUndefined()
    expect(body.choices[0].finish_reason).toBe('stop')
  })

  test('responses returns the JSON document as output text', async () => {
    const res = await request(modelsApp(toolCallModels(), 'responses'), 'responses', false)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      output: { type: string; content?: { type: string; text: string }[] }[]
    }
    expect(body.output.map((item) => item.type)).toEqual(['message'])
    expect(body.output[0]?.content).toMatchObject([{ type: 'output_text', text: document }])
  })

  test('chat streams the document as content deltas', async () => {
    const res = await request(modelsApp(toolCallModels(), 'openai'), 'openai', true)
    const frames = sseFrames(await res.text())
    const choices = frames.flatMap(
      (frame) => frame.choices as { delta?: Record<string, unknown>; finish_reason?: string }[]
    )
    expect(choices.map((c) => c.delta?.content ?? '').join('')).toBe(document)
    expect(choices.some((c) => c.delta?.tool_calls !== undefined)).toBe(false)
    expect(choices.at(-1)?.finish_reason).toBe('stop')
  })

  test('responses streams the document as output-text deltas', async () => {
    const res = await request(modelsApp(toolCallModels(), 'responses'), 'responses', true)
    const raw = await res.text()
    const frames = sseFrames(raw)
    const deltas = frames
      .filter((frame) => frame.type === 'response.output_text.delta')
      .map((frame) => String(frame.delta))
    expect(deltas.join('')).toBe(document)
    expect(raw).not.toContain('response.function_call_arguments')
    expect(frames.some((frame) => frame.type === 'response.completed')).toBe(true)
    expect(raw).toContain('data: [DONE]')
  })

  test('fails over to a candidate whose policy can enforce the schema', async () => {
    const enforcing: Provider = {
      name: 'b',
      type: 'openai-compatible',
      dispatch: async () => okResponse('b', 'x')
    }
    const app = modelsApp(toolCallModels('google-generative-ai'), 'openai', [['b', enforcing]])
    const res = await request(app, 'openai', false)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { choices: unknown[] }).choices).toHaveLength(1)
  })

  test('returns an explicit error when no candidate can enforce the schema', async () => {
    const res = await request(
      modelsApp(toolCallModels('google-generative-ai'), 'openai'),
      'openai',
      false
    )
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain('google-generative-ai')
    expect(body.error.message).toContain('json_schema')
  })
})

describe('stream failover', () => {
  // A member whose upstream fails before any content, like cerebras' 402.
  const failing = (provider: string, errorMessage: string): Provider =>
    createModelsDispatch(
      {
        getModel: () => stubModel({ provider }),
        stream: () => {
          const events = createAssistantMessageEventStream()
          const error = message(provider, { stopReason: 'error', errorMessage })
          events.push({ type: 'error', reason: 'error', error })
          events.end(error)
          return events
        }
      } as unknown as MutableModels,
      provider
    )

  const answering = (provider: string, text: string): Provider =>
    createModelsDispatch(
      {
        getModel: () => stubModel({ provider }),
        stream: () => {
          const events = createAssistantMessageEventStream()
          const partial = message(provider)
          const done = message(provider, { content: [{ type: 'text', text }] })
          events.push({ type: 'start', partial })
          events.push({ type: 'text_start', contentIndex: 0, partial })
          events.push({ type: 'text_delta', contentIndex: 0, delta: text, partial })
          events.push({ type: 'text_end', contentIndex: 0, content: text, partial })
          events.push({ type: 'done', reason: 'stop', message: done })
          events.end(done)
          return events
        }
      } as unknown as MutableModels,
      provider
    )

  const chat = { model: 'default/x', stream: true, messages: [{ role: 'user', content: 'hi' }] }

  test('chat stream fails over past a 402 before content, with no error event', async () => {
    const app = poolApp([
      ['a', failing('a', '402 status code (no body)')],
      ['b', answering('b', 'PONG')]
    ])
    const res = await post(app, '/v1/chat/completions', chat)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('"content":"PONG"')
    expect(text).not.toContain('"error"')
    expect(res.headers.get('x-pi-route-served-by')).toBe('b/x')
    expect(res.headers.get('x-pi-route-attempts')).toBe('a/x 402; b/x ok')
  })

  test('responses stream fails over and completes from the second member', async () => {
    const app = poolApp(
      [
        ['a', failing('a', '402 status code (no body)')],
        ['b', answering('b', 'PONG')]
      ],
      'responses'
    )
    const res = await post(app, '/v1/responses', { model: 'default/x', stream: true, input: 'hi' })
    const text = await res.text()
    expect(text).toContain('event: response.created')
    expect(text).toContain('event: response.completed')
    expect(text).toContain('PONG')
  })

  test('all members 402 → HTTP 402 with a body naming each attempt', async () => {
    const app = poolApp([
      ['a', failing('a', '402 status code (no body)')],
      ['b', failing('b', '402 status code (no body)')]
    ])
    const res = await post(app, '/v1/chat/completions', chat)
    expect(res.status).toBe(402)
    const body = (await res.json()) as {
      error: { message: string; type: string; attempts: { address: string; status?: number }[] }
    }
    expect(body.error.type).toBe('api_error')
    expect(body.error.message).toBe(
      'default/x: a/x 402 (402 status code (no body)); b/x 402 (402 status code (no body))'
    )
    expect(body.error.attempts.map((a) => [a.address, a.status])).toEqual([
      ['a/x', 402],
      ['b/x', 402]
    ])
    expect(res.headers.get('x-pi-route-attempts')).toBe('a/x 402; b/x 402')
    expect(res.headers.get('x-pi-route-served-by')).toBeNull()
  })

  test('all members 400 → HTTP 400 invalid_request_error', async () => {
    const app = poolApp([
      ['a', failing('a', '400 status code (no body)')],
      ['b', failing('b', '400 status code (no body)')]
    ])
    const res = await post(app, '/v1/chat/completions', chat)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe('invalid_request_error')
  })

  test('an auth short-circuit still names the attempts', async () => {
    const unauthorized: Provider = {
      name: 'b',
      type: 'openai-compatible',
      dispatch: async () => {
        throw new DispatchAuthError('OAuth refresh failed')
      }
    }
    const app = poolApp([
      ['a', failing('a', '402 status code (no body)')],
      ['b', unauthorized]
    ])
    const res = await post(app, '/v1/chat/completions', chat)
    expect(res.status).toBe(401)
    expect(res.headers.get('x-pi-route-attempts')).toBe('a/x 402; b/x 401')
  })

  test('mixed or unforwardable statuses become 502', async () => {
    const cases: [string, string][] = [
      ['402 status code (no body)', '429 status code (no body)'],
      ['401 status code (no body)', '401 status code (no body)']
    ]
    for (const [first, second] of cases) {
      const app = poolApp([
        ['a', failing('a', first)],
        ['b', failing('b', second)]
      ])
      expect((await post(app, '/v1/chat/completions', chat)).status).toBe(502)
    }
  })

  test('each hop and the final failure are logged', async () => {
    const lines: string[] = []
    const original = console.warn
    console.warn = (line: string) => {
      lines.push(line)
    }
    try {
      const app = poolApp([
        ['a', failing('a', '402 status code (no body)')],
        ['b', failing('b', '429 status code (no body)')]
      ])
      await post(app, '/v1/chat/completions', chat)
    } finally {
      console.warn = original
    }
    expect(lines).toEqual([
      '[failover] default/x: a/x 402 (402 status code (no body)) → b/x',
      '[failover] default/x: all 2 members failed → 502'
    ])
  })

  test('anthropic-format errors use the anthropic envelope', async () => {
    const app = poolApp([['a', failing('a', '429 status code (no body)')]], 'anthropic')
    const res = await post(app, '/v1/messages', {
      model: 'default/x',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }]
    })
    expect(res.status).toBe(429)
    const body = (await res.json()) as { type: string; error: { type: string; message: string } }
    expect(body.type).toBe('error')
    expect(body.error.type).toBe('api_error')
    expect(body.error.message).toContain('a/x 429')
  })
})

describe('endOnSettle', () => {
  test('ends the span exactly once when cancelled during a pending read', async () => {
    let ends = 0
    const span = {
      end: () => {
        ends += 1
      },
      addEvent: () => span
    } as unknown as Span
    const upstream = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) })
    const reader = endOnSettle(upstream, span).getReader()
    const pending = reader.read()
    await Bun.sleep(0)
    await reader.cancel()
    await pending
    await Bun.sleep(10)
    expect(ends).toBe(1)
  })
})
