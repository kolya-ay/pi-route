import { describe, expect, test } from 'bun:test'
import { buildCatalog } from '../pipeline/catalog'
import type { RouterOptions } from '../types'
import { createModelsRoute } from './models'

const opts = (over: Partial<RouterOptions> = {}): RouterOptions => ({
  providers: {
    cerebras: { type: 'cerebras', account: { credential: 'key', key: 'k' } }
  },
  pipeline: [],
  expose: [],
  ...over
})

describe('/v1/models', () => {
  test('emits OpenAI envelope', async () => {
    const o = opts()
    const app = createModelsRoute(o, buildCatalog(o))
    const r = await app.request('/')
    const body = (await r.json()) as { object: string; data: { id: string }[] }
    expect(body.object).toBe('list')
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.data.length).toBeGreaterThan(0)
  })

  test('every entry has id and object', async () => {
    const o = opts()
    const app = createModelsRoute(o, buildCatalog(o))
    const r = await app.request('/')
    const body = (await r.json()) as { data: Record<string, unknown>[] }
    for (const e of body.data) {
      expect(typeof e.id).toBe('string')
      expect(e.object).toBe('model')
    }
  })

  test('expose filter (allowlist)', async () => {
    const o = opts({
      pipeline: [{ kind: 'alias', name: 'opus', target: 'cerebras/llama-3.3-70b' }],
      expose: ['opus']
    })
    const app = createModelsRoute(o, buildCatalog(o))
    const r = await app.request('/')
    const body = (await r.json()) as { data: { id: string }[] }
    expect(body.data.map((e) => e.id)).toEqual(['opus'])
  })

  test('expose filter (allow-then-exclude)', async () => {
    const o = opts({ expose: ['**', '!cerebras/llama3.1-8b'] })
    const app = createModelsRoute(o, buildCatalog(o))
    const r = await app.request('/')
    const body = (await r.json()) as { data: { id: string }[] }
    expect(body.data.some((e) => e.id === 'cerebras/llama3.1-8b')).toBe(false)
  })

  test('emits pricing as per-token string when pi-ai has cost', async () => {
    const o = opts()
    const app = createModelsRoute(o, buildCatalog(o))
    const r = await app.request('/')
    const body = (await r.json()) as { data: { pricing?: { prompt: string } }[] }
    const withPricing = body.data.find((e) => e.pricing?.prompt !== undefined)
    if (withPricing?.pricing) {
      // per-token strings are tiny decimals
      expect(parseFloat(withPricing.pricing.prompt)).toBeLessThan(1)
    }
  })
})
