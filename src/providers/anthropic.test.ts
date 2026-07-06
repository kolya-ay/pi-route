// src/providers/anthropic.test.ts

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeCredentials } from '../auth/credentials'
import { collectLimitsSnapshot } from '../limits'
import { createState } from '../state'
import { createTel } from '../telemetry/tel'
import type { Account, IncomingRequest, RouterOptions } from '../types'
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

const originalFetch = globalThis.fetch
let limitsDir: string | null = null

const makeLimitsState = (account: Account, authDir: string) => {
  const options: RouterOptions = {
    providers: {
      claude: { type: 'anthropic', account }
    },
    pipeline: [],
    expose: []
  }
  return createState(options, null as never, { accounts: {} }, authDir)
}

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (limitsDir) {
    await rm(limitsDir, { recursive: true, force: true })
    limitsDir = null
  }
})

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

describe('anthropic limits snapshot', () => {
  it('returns unauthenticated when Claude usage has no oauth account', async () => {
    limitsDir = await mkdtemp(join(tmpdir(), 'pi-anthropic-limits-'))
    const snapshot = await collectLimitsSnapshot(
      makeLimitsState({ credential: 'key', key: 'sk-ant-xxx' }, limitsDir),
      createTel()
    )

    expect(snapshot.providers).toEqual([
      {
        name: 'claude',
        type: 'anthropic',
        display_name: 'Claude Code',
        status: 'unauthenticated',
        plan: null,
        session: null,
        weekly: null,
        credits: null,
        error_message: 'OAuth login required for Claude Code usage.',
        last_updated: null
      }
    ])
  })

  it('returns an error entry for a 401 Claude usage response', async () => {
    limitsDir = await mkdtemp(join(tmpdir(), 'pi-anthropic-limits-'))
    await writeCredentials(limitsDir, 'claude-oauth', {
      provider: 'anthropic',
      refresh: 'refresh-1',
      access: 'claude-token',
      expires: Date.now() + 60_000
    })
    globalThis.fetch = (async () =>
      new Response('unauthorized', { status: 401 })) as unknown as typeof fetch

    const snapshot = await collectLimitsSnapshot(
      makeLimitsState({ credential: 'oauth', name: 'claude-oauth' }, limitsDir),
      createTel()
    )

    expect(snapshot.providers[0]).toMatchObject({
      name: 'claude',
      status: 'error',
      error_message: 'Re-authenticate in Claude Code.',
      session: null,
      weekly: null,
      credits: null
    })
  })

  it('returns an error entry for a 403 Claude usage response', async () => {
    limitsDir = await mkdtemp(join(tmpdir(), 'pi-anthropic-limits-'))
    await writeCredentials(limitsDir, 'claude-oauth', {
      provider: 'anthropic',
      refresh: 'refresh-1',
      access: 'claude-token',
      expires: Date.now() + 60_000
    })
    globalThis.fetch = (async () =>
      new Response('forbidden', { status: 403 })) as unknown as typeof fetch

    const snapshot = await collectLimitsSnapshot(
      makeLimitsState({ credential: 'oauth', name: 'claude-oauth' }, limitsDir),
      createTel()
    )

    expect(snapshot.providers[0]).toMatchObject({
      name: 'claude',
      status: 'error',
      error_message: 'Re-authenticate in Claude Code.'
    })
  })

  it('returns an error entry when Claude usage JSON is invalid', async () => {
    limitsDir = await mkdtemp(join(tmpdir(), 'pi-anthropic-limits-'))
    await writeCredentials(limitsDir, 'claude-oauth', {
      provider: 'anthropic',
      refresh: 'refresh-1',
      access: 'claude-token',
      expires: Date.now() + 60_000
    })
    globalThis.fetch = (async () =>
      new Response('not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })) as unknown as typeof fetch

    const snapshot = await collectLimitsSnapshot(
      makeLimitsState({ credential: 'oauth', name: 'claude-oauth' }, limitsDir),
      createTel()
    )

    expect(snapshot.providers[0]).toMatchObject({
      name: 'claude',
      status: 'error',
      error_message: "Couldn't read usage."
    })
  })

  it('maps five_hour and seven_day usage and ignores seven_day_omelette', async () => {
    limitsDir = await mkdtemp(join(tmpdir(), 'pi-anthropic-limits-'))
    await writeCredentials(limitsDir, 'claude-oauth', {
      provider: 'anthropic',
      refresh: 'refresh-1',
      access: 'claude-token',
      expires: Date.now() + 60_000
    })
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          rate_limit_tier: 'default_max_20x',
          subscription_type: 'pro',
          five_hour: { utilization: 21, resets_at: '2026-07-05T10:00:00.000Z' },
          seven_day: { utilization: 34, resets_at: '2026-07-10T00:00:00.000Z' },
          seven_day_omelette: { utilization: 99, resets_at: '2099-01-01T00:00:00.000Z' },
          extra_usage: { is_enabled: true, used_credits: 12, monthly_limit: 30 }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as unknown as typeof fetch

    const snapshot = await collectLimitsSnapshot(
      makeLimitsState({ credential: 'oauth', name: 'claude-oauth' }, limitsDir),
      createTel()
    )

    expect(snapshot.providers[0]).toMatchObject({
      name: 'claude',
      type: 'anthropic',
      display_name: 'Claude Code',
      status: 'ok',
      plan: 'Max 20x',
      session: { used_percent: 21, resets_at: '2026-07-05T10:00:00.000Z' },
      weekly: { used_percent: 34, resets_at: '2026-07-10T00:00:00.000Z' },
      credits: { used: 12, cap: 30, currency: 'USD' },
      error_message: null
    })
    expect(snapshot.providers[0]?.weekly?.used_percent).not.toBe(99)
    expect(typeof snapshot.providers[0]?.last_updated).toBe('string')
  })
})
