import { describe, expect, test } from 'bun:test'
import { getModel } from '@mariozechner/pi-ai'
import type { RouterOptions } from '../types'
import { buildCatalog } from './catalog'
import {
  applyOverride,
  fallbackMeta,
  guessFromCatalog,
  normalizeModelId,
  parseLitellmModelInfo,
  parseOpenaiModelsList,
  resolveMetadata,
  toModelMeta
} from './metadata'

describe('toModelMeta', () => {
  // NOTE: gpt-oss-120b assertions pin pi-ai's bundled catalog; re-confirm on dependency bumps.
  test('maps a pi-ai model into ModelMeta with the projection fields', () => {
    const m = getModel('cerebras', 'gpt-oss-120b')
    const meta = toModelMeta(m)
    expect(meta.name).toBe(m.name)
    expect(meta.contextWindow).toBe(m.contextWindow)
    expect(meta.reasoning).toBe(Boolean(m.reasoning))
  })
})

describe('normalizeModelId', () => {
  test('lowercases, strips org prefix and quant/TEE suffixes, keeps version dots', () => {
    expect(normalizeModelId('MiniMaxAI/MiniMax-M2.5-TEE')).toBe('minimax-m2.5')
    expect(normalizeModelId('Qwen/Qwen3-32B-FP8')).toBe('qwen3-32b')
    expect(normalizeModelId('deepseek-ai/deepseek-v3.2')).toBe('deepseek-v3.2')
  })
})

describe('guessFromCatalog', () => {
  // NOTE: gpt-oss-120b assertions pin pi-ai's bundled catalog; re-confirm on dependency bumps.
  test("exact leaf match returns that model's metadata", () => {
    const meta = guessFromCatalog('nvidia/openai/gpt-oss-120b')
    expect(meta?.contextWindow).toBeGreaterThan(0)
  })

  test('no match returns null', () => {
    expect(guessFromCatalog('nvidia/totally/not-a-real-model-xyz')).toBeNull()
  })
})

describe('applyOverride', () => {
  test('patches fields over a base and keeps the rest', () => {
    const base = fallbackMeta('x')
    const out = applyOverride(base, { contextWindow: 999 })
    expect(out?.contextWindow).toBe(999)
    expect(out?.cost).toEqual(base.cost)
  })
  test('override alone makes a null base visible', () => {
    expect(applyOverride(null, { contextWindow: 5 })?.contextWindow).toBe(5)
  })
  test('null base + no override stays null', () => {
    expect(applyOverride(null, undefined)).toBeNull()
  })
  test('empty override object is a no-op (returns base unchanged)', () => {
    expect(applyOverride(null, {})).toBeNull()
  })
})

describe('resolveMetadata', () => {
  const base = (discover: string[], overrides = {}): RouterOptions => ({
    providers: {
      nv: {
        type: 'openai-compatible',
        baseUrl: 'http://x/v1',
        account: { credential: 'key', key: 'k' },
        discover: discover as never,
        modelOverrides: overrides
      }
    },
    pipeline: [],
    expose: ['nv/**']
  })

  test('fallback fills an otherwise-unknown model', () => {
    const opts = base(['fallback'])
    const cat = buildCatalog(opts)
    cat.addresses.add('nv/foo/bar')
    cat.leafFor.set('nv/foo/bar', 'nv/foo/bar')
    const meta = resolveMetadata(opts, cat, 'nv/foo/bar')
    expect(meta?.contextWindow).toBe(200000)
  })

  test('guess beats fallback when listed first', () => {
    const opts = base(['guess', 'fallback'])
    const cat = buildCatalog(opts)
    cat.addresses.add('nv/openai/gpt-oss-120b')
    cat.leafFor.set('nv/openai/gpt-oss-120b', 'nv/openai/gpt-oss-120b')
    const meta = resolveMetadata(opts, cat, 'nv/openai/gpt-oss-120b')
    expect(meta?.contextWindow).not.toBe(200000)
  })

  test('override patches the chain result', () => {
    const opts = base(['fallback'], { 'foo/bar': { contextWindow: 42 } })
    const cat = buildCatalog(opts)
    cat.addresses.add('nv/foo/bar')
    cat.leafFor.set('nv/foo/bar', 'nv/foo/bar')
    expect(resolveMetadata(opts, cat, 'nv/foo/bar')?.contextWindow).toBe(42)
  })

  test('live lookup keys on leaf, not address (alias resolution)', () => {
    // liveMeta is written as `${name}/${modelId}` = the leaf address.
    // An alias whose leaf points at a live entry must resolve correctly.
    const opts = base(['openai-models-list'])
    const cat = buildCatalog(opts)
    cat.liveMeta.set('nv/real-model', { name: 'Real', contextWindow: 40960, reasoning: false })
    cat.addresses.add('big')
    cat.leafFor.set('big', 'nv/real-model')
    expect(resolveMetadata(opts, cat, 'big')?.contextWindow).toBe(40960)
  })
})

describe('parseOpenaiModelsList', () => {
  test('maps chutes-style fields to ModelMeta', () => {
    const payload = {
      data: [
        {
          id: 'Qwen/Qwen3-32B-TEE',
          context_length: 40960,
          max_output_length: 40960,
          pricing: { prompt: 0.104, completion: 0.416 },
          input_modalities: ['text']
        }
      ]
    }
    const map = parseOpenaiModelsList(payload)
    const m = map.get('Qwen/Qwen3-32B-TEE')!
    expect(m.contextWindow).toBe(40960)
    expect(m.maxTokens).toBe(40960)
    expect(m.cost).toEqual({ input: 0.104, output: 0.416 })
    expect(m.input).toEqual(['text'])
  })
  test('malformed payload → empty map', () => {
    expect(parseOpenaiModelsList({ nope: 1 }).size).toBe(0)
  })
  test('numeric string pricing fields (OpenRouter style) are coerced', () => {
    const payload = {
      data: [{ id: 'some/model', pricing: { prompt: '0.1', completion: '0.4' } }]
    }
    const m = parseOpenaiModelsList(payload).get('some/model')!
    expect(m.cost).toEqual({ input: 0.1, output: 0.4 })
  })
})

describe('parseLitellmModelInfo', () => {
  test('maps litellm model_info to ModelMeta (cost scaled to per-million)', () => {
    const payload = {
      data: [
        {
          model_name: 'foo',
          model_info: {
            max_input_tokens: 131072,
            max_output_tokens: 8192,
            input_cost_per_token: 0.0000005,
            output_cost_per_token: 0.0000015,
            supports_reasoning: true
          }
        }
      ]
    }
    const m = parseLitellmModelInfo(payload).get('foo')!
    expect(m.contextWindow).toBe(131072)
    expect(m.cost).toEqual({ input: 0.5, output: 1.5 })
    expect(m.reasoning).toBe(true)
  })
})
