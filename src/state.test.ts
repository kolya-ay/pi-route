import { describe, expect, it } from 'bun:test'
import { createState } from './state'
import { createTelemetryEmitter } from './telemetry/emitter'
import type { RouterOptions } from './types'

const minimalOptions: RouterOptions = {
  server: { port: 3000, host: '127.0.0.1' },
  auth: { apiKeys: [] },
  providers: {
    p1: {
      type: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      accounts: [],
      balancing: { strategy: 'round-robin' }
    }
  },
  authDir: '/tmp/auth',
  routing: { rules: [], scenarios: {}, default: { provider: 'p1' } },
  telemetry: { level: 'info' }
}

describe('createState', () => {
  it('returns state with provided options, empty Maps, and wired hooks', () => {
    const telemetry = createTelemetryEmitter([])
    const persist = async () => {}
    const state = createState(minimalOptions, persist, telemetry)
    expect(state.options).toBe(minimalOptions)
    expect(state.credentials.size).toBe(0)
    expect(state.timers.size).toBe(0)
    expect(state.refreshFailures.size).toBe(0)
    expect(state.persist).toBe(persist)
    expect(state.telemetry).toBe(telemetry)
  })
})
