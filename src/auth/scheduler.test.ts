import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { RouterState } from '../state'
import { createState } from '../state'
import { createTelemetryEmitter } from '../telemetry/emitter'
import { writeCredentials } from './credentials'
import { cancelRefresh, scheduleRefresh } from './scheduler'

const mkState = (authDir: string): RouterState =>
  createState(
    {
      server: { port: 3000, host: '127.0.0.1' },
      auth: { apiKeys: [] },
      providers: {},
      authDir,
      routing: { rules: [], scenarios: {}, default: { provider: 'p1' } },
      telemetry: { level: 'info' }
    } as RouterState['options'],
    null,
    createTelemetryEmitter([])
  )

let originalFetch: typeof fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('scheduleRefresh', () => {
  it('is a no-op for api-key accounts', () => {
    const state = mkState('/tmp')
    scheduleRefresh(state, 'p1', { type: 'api-key', name: 'a', key: 'k' })
    expect(state.timers.size).toBe(0)
  })

  it('is a no-op when account is disabled', async () => {
    const dir = `/tmp/sched-${crypto.randomUUID()}`
    await writeCredentials(dir, 'a', {
      provider: 'google-antigravity',
      refreshToken: 'r',
      accessToken: 'k',
      expires: Date.now() + 120_000
    })
    const state = mkState(dir)
    scheduleRefresh(state, 'p1', { type: 'antigravity-oauth', name: 'a', disabled: true })
    expect(state.timers.size).toBe(0)
  })

  it('is a no-op when credential file does not exist', () => {
    const state = mkState(`/tmp/missing-${crypto.randomUUID()}`)
    scheduleRefresh(state, 'p1', { type: 'antigravity-oauth', name: 'a' })
    expect(state.timers.size).toBe(0)
  })

  it('schedules and fires refresh near expires - 60s', async () => {
    const dir = `/tmp/sched-${crypto.randomUUID()}`
    await writeCredentials(dir, 'a', {
      provider: 'google-antigravity',
      refreshToken: 'r',
      accessToken: 'k',
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

    scheduleRefresh(state, 'p1', { type: 'antigravity-oauth', name: 'a' })
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
      refreshToken: 'r',
      accessToken: 'k',
      expires: Date.now() + 120_000
    })
    const state = mkState(dir)
    scheduleRefresh(state, 'p1', { type: 'antigravity-oauth', name: 'a' })
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
      refreshToken: 'r',
      accessToken: 'k',
      expires: Date.now() + 61_500
    })
    const events: Array<{ type: string }> = []
    const state: RouterState = {
      ...mkState(dir),
      telemetry: { sinks: [], emit: (e) => events.push(e as { type: string }) }
    }

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400
      })) as unknown as typeof fetch

    scheduleRefresh(state, 'p1', { type: 'antigravity-oauth', name: 'a' })
    // Wait long enough for first fire + 5 backoff attempts (1+2+4+8+16+32 = 63s — too long).
    // Instead, manually drive: fire one failure, then verify counter.
    await Bun.sleep(2500)
    expect(state.refreshFailures.get('a') ?? 0).toBeGreaterThanOrEqual(1)
  }, 10_000)
})
