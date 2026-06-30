import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { SpanStatusCode } from '@opentelemetry/api'
import type { RouterState } from '../state'
import { createState } from '../state'
import { createTel, type Tel } from '../telemetry/tel'
import { useTestExporter } from '../telemetry/test-fixture'
import type { RouterOptions } from '../types'
import { writeCredentials } from './credentials'
import { cancelRefresh, scheduleRefresh } from './scheduler'

const baseOptions: RouterOptions = {
  providers: {},
  pipeline: [],
  expose: []
}

const mkState = (authDir: string): RouterState =>
  createState(baseOptions, null as never, { accounts: {} }, authDir)

const exporter = useTestExporter()
let tel: Tel
let originalFetch: typeof fetch

beforeEach(() => {
  tel = createTel()
  originalFetch = globalThis.fetch
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('scheduleRefresh', () => {
  it('is a no-op for key-credential accounts', () => {
    const state = mkState('/tmp')
    scheduleRefresh(state, 'p1', { credential: 'key', key: 'k' }, tel)
    expect(state.timers.size).toBe(0)
  })

  it('is a no-op when account is disabled', async () => {
    const dir = `/tmp/sched-${crypto.randomUUID()}`
    await writeCredentials(dir, 'a', {
      provider: 'google-antigravity',
      refresh: 'r',
      access: 'k',
      expires: Date.now() + 120_000
    })
    const state = mkState(dir)
    scheduleRefresh(
      state,
      'p1',
      {
        credential: 'oauth',
        name: 'a',
        disabled: true
      },
      tel
    )
    expect(state.timers.size).toBe(0)
  })

  it('is a no-op when credential file does not exist', () => {
    const state = mkState(`/tmp/missing-${crypto.randomUUID()}`)
    scheduleRefresh(state, 'p1', { credential: 'oauth', name: 'a' }, tel)
    expect(state.timers.size).toBe(0)
  })

  it('schedules and fires refresh near expires - 60s', async () => {
    const dir = `/tmp/sched-${crypto.randomUUID()}`
    await writeCredentials(dir, 'a', {
      provider: 'google-antigravity',
      refresh: 'r',
      access: 'k',
      expires: Date.now() + 61_500 // ~1.5s from now after subtracting 60s
    })
    const state = mkState(dir)

    let refreshed = false
    globalThis.fetch = (async () => {
      refreshed = true
      return new Response(
        JSON.stringify({ access_token: 'new', refresh_token: 'newr', expires_in: 3600 }),
        { status: 200 }
      )
    }) as unknown as typeof fetch

    scheduleRefresh(state, 'p1', { credential: 'oauth', name: 'a' }, tel)
    expect(state.timers.size).toBe(1)

    await Bun.sleep(2500)
    expect(refreshed).toBe(true)
  }, 5000)
})

describe('cancelRefresh', () => {
  it('clears the timer and removes from state', async () => {
    const dir = `/tmp/cancel-${crypto.randomUUID()}`
    await writeCredentials(dir, 'a', {
      provider: 'google-antigravity',
      refresh: 'r',
      access: 'k',
      expires: Date.now() + 120_000
    })
    const state = mkState(dir)
    scheduleRefresh(state, 'p1', { credential: 'oauth', name: 'a' }, tel)
    expect(state.timers.size).toBe(1)
    cancelRefresh(state, 'a')
    expect(state.timers.size).toBe(0)
    expect(state.refreshFailures.has('a')).toBe(false)
  })
})

describe('refresh failure backoff', () => {
  it('increments state.refreshFailures on a failed refresh', async () => {
    const dir = `/tmp/fail-${crypto.randomUUID()}`
    await writeCredentials(dir, 'a', {
      provider: 'google-antigravity',
      refresh: 'r',
      access: 'k',
      expires: Date.now() + 61_500
    })
    const state = mkState(dir)

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400
      })) as unknown as typeof fetch

    scheduleRefresh(state, 'p1', { credential: 'oauth', name: 'a' }, tel)
    // Wait long enough for first fire + 5 backoff attempts (1+2+4+8+16+32 = 63s — too long).
    // Instead, manually drive: fire one failure, then verify counter.
    await Bun.sleep(2500)
    expect(state.refreshFailures.get('a') ?? 0).toBeGreaterThanOrEqual(1)
    // Verify an account.refresh span was created AND its status is ERROR
    // (scheduler catches the rejection without rethrowing, so the span has to
    // set status explicitly — otherwise SigNoz "errors only" views miss it).
    const spans = exporter.getFinishedSpans()
    const refresh = spans.find((s) => s.name === 'account.refresh')
    expect(refresh).toBeDefined()
    expect(refresh?.status.code).toBe(SpanStatusCode.ERROR)
  }, 10_000)

  it('emits account.refresh.given_up as a root-level span (not child of account.refresh)', async () => {
    const dir = `/tmp/giveup-${crypto.randomUUID()}`
    await writeCredentials(dir, 'a', {
      provider: 'google-antigravity',
      refresh: 'r',
      access: 'k',
      expires: Date.now() + 61_500
    })
    const state = mkState(dir)
    // Pre-seed failures to MAX_FAILURES-1 so the next fire tips over into give-up.
    state.refreshFailures.set('a', 5)

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400
      })) as unknown as typeof fetch

    scheduleRefresh(state, 'p1', { credential: 'oauth', name: 'a' }, tel)
    // Wait for the single fire to complete (~1.5s timer + network round-trip).
    await Bun.sleep(2500)

    const spans = exporter.getFinishedSpans()
    const givenUp = spans.find((s) => s.name === 'account.refresh.given_up')
    const refresh = spans.find((s) => s.name === 'account.refresh')
    expect(givenUp).toBeDefined()
    expect(refresh).toBeDefined()
    // Standalone span: its parent span id should NOT equal the refresh span's span id.
    expect(givenUp?.parentSpanContext?.spanId).toBeUndefined()
  }, 10_000)
})
