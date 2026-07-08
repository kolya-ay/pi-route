import { describe, expect, test } from 'bun:test'
import { buildCatalog } from '../pipeline/catalog'
import type { RouterOptions } from '../types'
import { buildModelInfoBody } from './model-info'

const opts = (over: Partial<RouterOptions> = {}): RouterOptions => ({
  providers: { cerebras: { type: 'cerebras', account: { credential: 'key', key: 'k' } } },
  pipeline: [],
  expose: [],
  ...over
})

describe('/model/info (LiteLLM)', () => {
  test('wraps entries in { data } and omits unknown models', () => {
    const o = opts()
    const body = buildModelInfoBody(o, buildCatalog(o))
    expect(Array.isArray(body.data)).toBe(true)
    for (const e of body.data) {
      expect(typeof e.model_name).toBe('string')
      expect(e.litellm_params.model).toBe(e.model_name)
      expect(e.model_info.key).toBe(e.model_name)
      expect(e.model_info.mode).toBe('chat')
      expect(e.model_info.supports_function_calling).toBe(true)
    }
  })
  test('cost is per-token NUMBER (< 1e-3) when present', () => {
    const o = opts()
    const body = buildModelInfoBody(o, buildCatalog(o))
    const priced = body.data.find((e) => e.model_info.input_cost_per_token !== undefined)
    if (!priced) return
    expect(typeof priced.model_info.input_cost_per_token).toBe('number')
    expect(priced.model_info.input_cost_per_token as number).toBeLessThan(1e-3)
  })
  test('respects expose allowlist', () => {
    const o = opts({
      pipeline: [{ kind: 'alias', name: 'solo', target: 'cerebras/gpt-oss-120b' }],
      expose: ['solo']
    })
    const body = buildModelInfoBody(o, buildCatalog(o))
    expect(body.data.map((e) => e.model_name)).toEqual(['solo'])
  })
})
