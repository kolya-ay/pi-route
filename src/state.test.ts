import { describe, expect, it } from 'bun:test'
import { buildCatalog } from './pipeline/catalog'
import { createState } from './state'
import type { RouterOptions } from './types'

const minimalOptions: RouterOptions = {
  providers: {
    p1: { type: 'anthropic', account: { credential: 'key', key: 'sk-test' } }
  },
  pipeline: [],
  expose: []
}

describe('createState', () => {
  it('returns state with provided options and empty Maps', () => {
    const catalog = buildCatalog(minimalOptions)
    const runtime = { accounts: {} }
    const state = createState(minimalOptions, catalog, runtime, '/tmp/auth')
    expect(state.options).toBe(minimalOptions)
    expect(state.catalog).toBe(catalog)
    expect(state.runtime).toBe(runtime)
    expect(state.authDir).toBe('/tmp/auth')
    expect(state.credentials.size).toBe(0)
    expect(state.timers.size).toBe(0)
    expect(state.refreshFailures.size).toBe(0)
  })
})
