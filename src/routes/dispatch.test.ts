// src/routes/dispatch.test.ts

import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { buildCatalog } from '../pipeline/catalog'
import type { ProviderEntry } from '../providers/registry'
import { createState } from '../state'
import { createTelemetryEmitter } from '../telemetry/emitter'
import type { Account, Provider, RouterOptions, TelemetryEvent } from '../types'
import { createDispatchHandler } from './dispatch'

type Env = { Variables: { requestId: string } }

const mkApp = (
  options: RouterOptions,
  registry: Map<string, ProviderEntry>,
  events: TelemetryEvent[]
): Hono<Env> => {
  const telemetry = createTelemetryEmitter([{ emit: (e) => events.push(e) }])
  const catalog = buildCatalog(options)
  const state = createState(options, catalog, { accounts: {} }, '/tmp', telemetry)
  const app = new Hono<Env>()
  app.use('*', async (c, next) => {
    c.set('requestId', 'test-req-1')
    await next()
  })
  app.post(
    '/v1/chat/completions',
    createDispatchHandler({
      format: 'openai',
      registry,
      state,
      telemetry
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
    const events: TelemetryEvent[] = []
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

    const app = mkApp(options, registry, events)
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt/x', messages: [{ role: 'user', content: 'hi' }] })
    })

    expect(res.status).toBe(200)
    expect(calls).toEqual(['a', 'b'])
    const fb = events.find((e) => e.type === 'provider_fallback')
    expect(fb).toBeDefined()
    if (fb?.type !== 'provider_fallback') throw new Error('unreachable')
    expect(fb.from).toBe('a/x')
    expect(fb.to).toBe('b/x')
    expect(fb.reason).toContain('boom')
  })

  test('all members fail → 502 + provider_error with last message; one fallback hop', async () => {
    const events: TelemetryEvent[] = []

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

    const app = mkApp(options, registry, events)
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt/x', messages: [{ role: 'user', content: 'hi' }] })
    })

    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('second-fail')
    const err = events.find((e) => e.type === 'provider_error')
    if (err?.type !== 'provider_error') throw new Error('unreachable')
    expect(err.message).toContain('second-fail')
    const hops = events.filter((e) => e.type === 'provider_fallback')
    expect(hops).toHaveLength(1)
  })
})
