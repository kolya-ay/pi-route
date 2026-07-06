import { afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessageEventStream } from '@mariozechner/pi-ai'
import { writeCredentials } from '../auth/credentials'
import { collectLimitsSnapshot } from '../limits'
import { createState } from '../state'
import { createTel } from '../telemetry/tel'
import type { Account, IncomingRequest, RouterOptions } from '../types'
import { createOpenAICodexProvider } from './openai-codex'

const makeRequest = (opts: { stream: boolean }): IncomingRequest => ({
  id: 'req-1',
  format: 'openai',
  rawRequest: new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'gpt-5.3-codex',
      messages: [{ role: 'user', content: 'hi' }],
      stream: opts.stream
    })
  }),
  model: 'gpt-5.3-codex',
  stream: opts.stream
})

const account: Account = { credential: 'oauth', name: 'me@example.com' }

const originalFetch = globalThis.fetch
let limitsDir: string | null = null

const makeLimitsState = (account: Account, authDir: string) => {
  const options: RouterOptions = {
    providers: {
      codex: { type: 'openai-codex', account }
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
        model: 'gpt-5.3-codex',
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
      expect((model as { id: string }).id).toBe('gpt-5.3-codex')
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

  it('passes maxRetries=3 and maxRetryDelayMs=30000 to pi-ai', async () => {
    const piAi = await import('@mariozechner/pi-ai')
    let capturedOpts: unknown
    const { restore } = await stubCodexStream((_m, _ctx, opts) => {
      capturedOpts = opts
      const stream = piAi.createAssistantMessageEventStream()
      pushDoneEvent(stream)
      return stream
    })

    try {
      const provider = createOpenAICodexProvider('codex')
      await provider.dispatch(makeRequest({ stream: false }), account, 'jwt-here')
      const o = capturedOpts as { maxRetries: number; maxRetryDelayMs: number }
      expect(o.maxRetries).toBe(3)
      expect(o.maxRetryDelayMs).toBe(30_000)
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

describe('openai-codex limits snapshot', () => {
  it('returns unauthenticated when Codex usage has no oauth account', async () => {
    limitsDir = await mkdtemp(join(tmpdir(), 'pi-codex-limits-'))
    const snapshot = await collectLimitsSnapshot(
      makeLimitsState({ credential: 'key', key: 'sk-codex' }, limitsDir),
      createTel()
    )

    expect(snapshot.providers).toEqual([
      {
        name: 'codex',
        type: 'openai-codex',
        display_name: 'Codex',
        status: 'unauthenticated',
        plan: null,
        session: null,
        weekly: null,
        credits: null,
        error_message: 'OAuth login required for Codex usage.',
        last_updated: null
      }
    ])
  })

  it('sends ChatGPT-Account-Id from the decoded JWT when present', async () => {
    limitsDir = await mkdtemp(join(tmpdir(), 'pi-codex-limits-'))
    await writeCredentials(limitsDir, 'codex-oauth', {
      provider: 'openai-codex',
      refresh: 'refresh-2',
      access:
        'header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC0xIn19.sig',
      expires: Date.now() + 60_000
    })

    let accountId: string | null = null
    globalThis.fetch = (async (_input: Request | string | URL, init?: RequestInit) => {
      const headers = init?.headers ? new Headers(init.headers) : new Headers()
      accountId = headers.get('ChatGPT-Account-Id')
      return new Response(
        JSON.stringify({
          plan_type: 'pro',
          rate_limit: {
            primary_window: { used_percent: 10, reset_at: '2026-07-05T10:00:00.000Z' },
            secondary_window: { used_percent: 20, reset_at: '2026-07-10T00:00:00.000Z' }
          },
          credits: { has_credits: false, balance: 0 }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    await collectLimitsSnapshot(
      makeLimitsState({ credential: 'oauth', name: 'codex-oauth' }, limitsDir),
      createTel()
    )

    if (!accountId) throw new Error('missing ChatGPT-Account-Id header')
    expect(accountId === 'acct-1').toBe(true)
  })

  it('returns an error entry for a 401 Codex usage response', async () => {
    limitsDir = await mkdtemp(join(tmpdir(), 'pi-codex-limits-'))
    await writeCredentials(limitsDir, 'codex-oauth', {
      provider: 'openai-codex',
      refresh: 'refresh-2',
      access: 'header.payload.sig',
      expires: Date.now() + 60_000
    })
    globalThis.fetch = (async () =>
      new Response('unauthorized', { status: 401 })) as unknown as typeof fetch

    const snapshot = await collectLimitsSnapshot(
      makeLimitsState({ credential: 'oauth', name: 'codex-oauth' }, limitsDir),
      createTel()
    )

    expect(snapshot.providers[0]).toMatchObject({
      name: 'codex',
      status: 'error',
      error_message: 'Re-authenticate in the Codex CLI.'
    })
  })

  it('returns an error entry for a 403 Codex usage response', async () => {
    limitsDir = await mkdtemp(join(tmpdir(), 'pi-codex-limits-'))
    await writeCredentials(limitsDir, 'codex-oauth', {
      provider: 'openai-codex',
      refresh: 'refresh-2',
      access: 'header.payload.sig',
      expires: Date.now() + 60_000
    })
    globalThis.fetch = (async () =>
      new Response('forbidden', { status: 403 })) as unknown as typeof fetch

    const snapshot = await collectLimitsSnapshot(
      makeLimitsState({ credential: 'oauth', name: 'codex-oauth' }, limitsDir),
      createTel()
    )

    expect(snapshot.providers[0]).toMatchObject({
      name: 'codex',
      status: 'error',
      error_message: 'Re-authenticate in the Codex CLI.'
    })
  })

  it('returns an error entry when Codex usage JSON is invalid', async () => {
    limitsDir = await mkdtemp(join(tmpdir(), 'pi-codex-limits-'))
    await writeCredentials(limitsDir, 'codex-oauth', {
      provider: 'openai-codex',
      refresh: 'refresh-2',
      access: 'header.payload.sig',
      expires: Date.now() + 60_000
    })
    globalThis.fetch = (async () =>
      new Response('not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })) as unknown as typeof fetch

    const snapshot = await collectLimitsSnapshot(
      makeLimitsState({ credential: 'oauth', name: 'codex-oauth' }, limitsDir),
      createTel()
    )

    expect(snapshot.providers[0]).toMatchObject({
      name: 'codex',
      status: 'error',
      error_message: "Couldn't read usage."
    })
  })

  it('maps primary and secondary usage and ignores code_review_rate_limit', async () => {
    limitsDir = await mkdtemp(join(tmpdir(), 'pi-codex-limits-'))
    await writeCredentials(limitsDir, 'codex-oauth', {
      provider: 'openai-codex',
      refresh: 'refresh-2',
      access: 'header.payload.sig',
      expires: Date.now() + 60_000
    })
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          plan_type: 'plus',
          rate_limit: {
            primary_window: { used_percent: 45, reset_at: '2026-07-05T10:00:00.000Z' },
            secondary_window: { used_percent: 67, reset_at: '2026-07-10T00:00:00.000Z' }
          },
          code_review_rate_limit: {
            used_percent: 99,
            reset_at: '2099-01-01T00:00:00.000Z'
          },
          credits: { has_credits: true, balance: 7 }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as unknown as typeof fetch

    const snapshot = await collectLimitsSnapshot(
      makeLimitsState({ credential: 'oauth', name: 'codex-oauth' }, limitsDir),
      createTel()
    )

    expect(snapshot.providers[0]).toMatchObject({
      name: 'codex',
      type: 'openai-codex',
      display_name: 'Codex',
      status: 'ok',
      plan: 'Plus',
      session: { used_percent: 45, resets_at: '2026-07-05T10:00:00.000Z' },
      weekly: { used_percent: 67, resets_at: '2026-07-10T00:00:00.000Z' },
      credits: { used: 7, cap: 0, currency: 'USD' },
      error_message: null
    })
    expect(snapshot.providers[0]?.weekly?.used_percent).not.toBe(99)
    expect(typeof snapshot.providers[0]?.last_updated).toBe('string')
  })
})
