import { describe, expect, it } from 'bun:test'
import { buildTestModels } from './models/test-models'
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
  it('returns state with provided options', () => {
    const models = buildTestModels(minimalOptions)
    const catalog = buildCatalog(minimalOptions, models, '/tmp')
    const runtime = { accounts: {} }
    const state = createState(minimalOptions, catalog, models, runtime, '/tmp/auth')
    expect(state.options).toBe(minimalOptions)
    expect(state.catalog).toBe(catalog)
    expect(state.models).toBe(models)
    expect(state.runtime).toBe(runtime)
    expect(state.authDir).toBe('/tmp/auth')
  })
})
