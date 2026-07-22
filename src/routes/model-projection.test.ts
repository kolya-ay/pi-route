import { describe, expect, test } from 'bun:test'
import { buildTestModels } from '../models/test-models'
import { buildCatalog } from '../pipeline/catalog'
import type { RouterOptions } from '../types'
import {
  capabilities,
  displayName,
  perTokenString,
  type Resolved,
  resolveModel,
  toLiteLLMInfo,
  toModelsDevModel,
  toOpenAIModel
} from './model-projection'

const opts = (over: Partial<RouterOptions> = {}): RouterOptions => ({
  providers: { cerebras: { type: 'cerebras', account: { credential: 'key', key: 'k' } } },
  pipeline: [],
  expose: [],
  ...over
})

const firstKnown = (o: RouterOptions) => {
  const models = buildTestModels(o)
  const cat = buildCatalog(o, models, '/tmp', new Map())
  for (const a of [...cat.addresses].sort()) {
    const r = resolveModel(o, cat, models, a)
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
    const models = buildTestModels(o)
    const r = resolveModel(o, buildCatalog(o, models, '/tmp', new Map()), models, 'ghost/model-x')
    expect(r).toEqual({ id: 'ghost/model-x', owned_by: 'ghost', provider: 'ghost', model: null })
  })
  test('known cerebras leaf resolves a Model', () => {
    const r = firstKnown(opts())
    expect(r?.model).toBeTruthy()
  })
})

describe('displayName (provider-prefixed)', () => {
  test('capitalizes the provider and slash-joins', () => {
    expect(displayName('nvidia', 'Kimi K2.6')).toBe('Nvidia/Kimi K2.6')
    expect(displayName('cerebras', 'GPT-OSS 120B')).toBe('Cerebras/GPT-OSS 120B')
  })
  test('endpoints emit the prefixed name for a resolved model', () => {
    const r = firstKnown(opts())
    if (!r?.model) return
    expect(toOpenAIModel(r).name).toBe(displayName(r.provider, r.model.name))
    expect(toModelsDevModel(r)?.name).toBe(displayName(r.provider, r.model.name))
  })
  test('prefix uses the backend provider for an alias (solo → Cerebras/…)', () => {
    const o = opts({
      pipeline: [{ kind: 'alias', name: 'solo', target: 'cerebras/gpt-oss-120b' }],
      expose: ['solo']
    })
    const models = buildTestModels(o)
    const r = resolveModel(o, buildCatalog(o, models, '/tmp', new Map()), models, 'solo')
    expect(r.owned_by).toBe('solo') // address-based
    expect(r.provider).toBe('cerebras') // leaf/backend-based
    if (r.model) expect(toOpenAIModel(r).name?.startsWith('Cerebras/')).toBe(true)
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
    expect(toOpenAIModel({ id: 'a/b', owned_by: 'a', provider: 'a', model: null })).toEqual({
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

// A vLLM/chutes-style endpoint reports a real contextWindow but no output-token
// limit. toModelMeta (the one Model -> ModelMeta boundary) normalizes that
// endpoint's "0 = unknown" sentinel into real absence, so the ModelMeta the
// projections see here simply has no `maxTokens` field — it must stay absent
// in the output, not resurface as a published zero.
const undescribedMaxTokens: Resolved = {
  id: 'nvidia/some-model',
  owned_by: 'nvidia',
  provider: 'nvidia',
  model: { name: 'some-model', contextWindow: 200000 }
}

describe('toOpenAIModel (maxTokens sentinel)', () => {
  test('an absent maxTokens is omitted, not published as zero', () => {
    const e = toOpenAIModel(undescribedMaxTokens)
    expect(e.max_tokens).toBeUndefined()
    expect(e.top_provider).toBeUndefined()
  })
})

describe('toLiteLLMInfo (maxTokens sentinel)', () => {
  test('an absent maxTokens is omitted, not published as zero', () => {
    const info = toLiteLLMInfo(undescribedMaxTokens)
    expect(info?.model_info.max_output_tokens).toBeUndefined()
  })
})

describe('toModelsDevModel (maxTokens sentinel)', () => {
  test('an absent maxTokens is omitted, not published as zero', () => {
    const m = toModelsDevModel(undescribedMaxTokens)
    expect(m?.limit.output).toBeUndefined()
  })
})
