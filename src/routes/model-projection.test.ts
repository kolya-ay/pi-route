import { describe, expect, test } from 'bun:test'
import { buildCatalog } from '../pipeline/catalog'
import type { RouterOptions } from '../types'
import { capabilities, perTokenString, resolveModel, toOpenAIModel } from './model-projection'

const opts = (over: Partial<RouterOptions> = {}): RouterOptions => ({
  providers: { cerebras: { type: 'cerebras', account: { credential: 'key', key: 'k' } } },
  pipeline: [],
  expose: [],
  ...over
})

const firstKnown = (o: RouterOptions) => {
  const cat = buildCatalog(o)
  for (const a of [...cat.addresses].sort()) {
    const r = resolveModel(o, cat, a)
    if (r.model) return r
  }
  return null
}

describe('cost helpers', () => {
  test('perTokenString divides per-million and trims', () => {
    expect(perTokenString(0.25)).toBe('0.00000025')
    expect(perTokenString(undefined)).toBeUndefined()
    expect(perTokenString(0)).toBe('0')
  })
})

describe('resolveModel', () => {
  test('unknown provider → null model, keeps id/owned_by', () => {
    const o = opts({ providers: {} })
    const r = resolveModel(o, buildCatalog(o), 'ghost/model-x')
    expect(r).toEqual({ id: 'ghost/model-x', owned_by: 'ghost', model: null })
  })
  test('known cerebras leaf resolves a Model', () => {
    const r = firstKnown(opts())
    expect(r?.model).toBeTruthy()
  })
})

describe('capabilities', () => {
  test('tools and temperature are always true', () => {
    const r = firstKnown(opts())
    if (!r?.model) return
    const cap = capabilities(r.model)
    expect(cap.tools).toBe(true)
    expect(cap.temperature).toBe(true)
    expect(typeof cap.reasoning).toBe('boolean')
    expect(Array.isArray(cap.efforts)).toBe(true)
  })
})

describe('toOpenAIModel', () => {
  test('degrades to base entry when model is null', () => {
    expect(toOpenAIModel({ id: 'a/b', owned_by: 'a', model: null })).toEqual({
      id: 'a/b',
      object: 'model',
      created: 0,
      owned_by: 'a'
    })
  })
  test('enriched entry carries Vercel keys + OpenRouter aliases', () => {
    const r = firstKnown(opts())
    if (!r?.model) return
    const e = toOpenAIModel(r)
    expect(e.context_window).toBe(e.context_length)
    expect(e.max_model_len).toBe(e.context_length)
    expect(e.type).toBe('language')
    expect(e.architecture?.output_modalities).toEqual(['text'])
    expect(e.supported_parameters).toContain('tools')
    if (e.pricing?.prompt !== undefined) expect(e.pricing.input).toBe(e.pricing.prompt)
  })
})
