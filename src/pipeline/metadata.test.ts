import { afterEach, describe, expect, test } from 'bun:test'
import type { Models } from '@earendil-works/pi-ai'
import { buildTestModels } from '../models/test-models'
import type { RouterOptions } from '../types'
import { buildCatalog, type Catalog } from './catalog'
import {
  applyOverride,
  enrichLiveMeta,
  fallbackMeta,
  fetchProviderMetadata,
  guessFromCatalog,
  normalizeModelId,
  parseLitellmModelInfo,
  parseOpenaiModelsList,
  resolveMetadata,
  toModelMeta
} from './metadata'

// A Models with cerebras (static catalog incl. gpt-oss-120b) for guess/toModelMeta.
const cerebrasModels = () =>
  buildTestModels({
    providers: { cerebras: { type: 'cerebras', account: { credential: 'key', key: 'k' } } },
    pipeline: [],
    expose: []
  })

describe('toModelMeta', () => {
  // NOTE: gpt-oss-120b assertions pin the bundled catalog; re-confirm on dependency bumps.
  test('maps a Model into ModelMeta with the projection fields', () => {
    const m = cerebrasModels().getModel('cerebras', 'gpt-oss-120b')!
    const meta = toModelMeta(m)
    expect(meta.name).toBe(m.name)
    expect(meta.contextWindow).toBe(m.contextWindow)
    expect(meta.reasoning).toBe(Boolean(m.reasoning))
  })

  // `Model` requires non-optional numbers, so an endpoint that didn't describe a
  // field surfaces as 0 (see cached-catalog.ts). toModelMeta is the one Model ->
  // ModelMeta boundary, so it's the one place that can turn "0 = unknown" back into
  // real absence, instead of every downstream reader having to know the sentinel.
  test('a Model reporting contextWindow: 0 and maxTokens: 0 omits both, not publishes zero', () => {
    const m = fakeModel('nvidia', 'some-model', 0)
    const meta = toModelMeta(m as unknown as Parameters<typeof toModelMeta>[0])
    expect(meta.contextWindow).toBeUndefined()
    expect(meta.maxTokens).toBeUndefined()
  })

  // Model records reach here through an unchecked cast from on-disk JSON, so
  // `undefined` is not the only absent-ish value that arrives.
  test('toModelMeta treats a null cost as absent rather than throwing', () => {
    const meta = toModelMeta({
      id: 'x',
      name: 'X',
      cost: null,
      contextWindow: 1000,
      maxTokens: 100
    } as never)
    expect(meta.cost).toBeUndefined()
    expect(meta.contextWindow).toBe(1000)
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
  // NOTE: gpt-oss-120b assertions pin the bundled catalog; re-confirm on dependency bumps.
  test("exact leaf match returns that model's metadata", () => {
    const meta = guessFromCatalog(cerebrasModels(), 'nvidia/gpt-oss-120b')
    expect(meta?.contextWindow).toBeGreaterThan(0)
  })

  test('no match returns null', () => {
    expect(guessFromCatalog(cerebrasModels(), 'nvidia/totally/not-a-real-model-xyz')).toBeNull()
  })
})

describe('applyOverride', () => {
  test('patches fields over a base and keeps the rest', () => {
    // The base needs a real cost: fallbackMeta leaves it unset, which would make
    // the "kept the rest" assertion compare undefined to undefined and test nothing.
    const base = { ...fallbackMeta('x'), cost: { input: 1.5, output: 3 } }
    const out = applyOverride(base, { contextWindow: 999 })
    expect(out?.contextWindow).toBe(999)
    expect(out?.cost).toEqual(base.cost)
    expect(out?.name).toBe('x')
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
    const models = cerebrasModels()
    const cat = buildCatalog(opts, models, '/tmp', new Map())
    cat.addresses.add('nv/foo/bar')
    cat.leafFor.set('nv/foo/bar', 'nv/foo/bar')
    const meta = resolveMetadata(opts, cat, models, 'nv/foo/bar')
    expect(meta?.contextWindow).toBe(200000)
  })

  test('fallback reports an unknown price rather than inventing a free one', () => {
    const opts = base(['fallback'])
    const models = cerebrasModels()
    const cat = buildCatalog(opts, models, '/tmp', new Map())
    cat.addresses.add('nv/foo/bar')
    cat.leafFor.set('nv/foo/bar', 'nv/foo/bar')
    const meta = resolveMetadata(opts, cat, models, 'nv/foo/bar')
    expect(meta?.contextWindow).toBe(200000)
    expect(meta?.cost).toBeUndefined()
  })

  test('guess beats fallback when listed first', () => {
    const opts = base(['guess', 'fallback'])
    const models = cerebrasModels()
    const cat = buildCatalog(opts, models, '/tmp', new Map())
    cat.addresses.add('nv/gpt-oss-120b')
    cat.leafFor.set('nv/gpt-oss-120b', 'nv/gpt-oss-120b')
    const meta = resolveMetadata(opts, cat, models, 'nv/gpt-oss-120b')
    expect(meta?.contextWindow).not.toBe(200000)
  })

  test('override patches the chain result', () => {
    const opts = base(['fallback'], { 'foo/bar': { contextWindow: 42 } })
    const models = cerebrasModels()
    const cat = buildCatalog(opts, models, '/tmp', new Map())
    cat.addresses.add('nv/foo/bar')
    cat.leafFor.set('nv/foo/bar', 'nv/foo/bar')
    expect(resolveMetadata(opts, cat, models, 'nv/foo/bar')?.contextWindow).toBe(42)
  })

  test('live lookup keys on leaf, not address (alias resolution)', () => {
    // liveMeta is written as `${name}/${modelId}` = the leaf address.
    // An alias whose leaf points at a live entry must resolve correctly.
    const opts = base(['openai-models-list'])
    const models = cerebrasModels()
    const cat = buildCatalog(opts, models, '/tmp', new Map())
    cat.liveMeta.set('nv/real-model', { name: 'Real', contextWindow: 40960, reasoning: false })
    cat.addresses.add('big')
    cat.leafFor.set('big', 'nv/real-model')
    expect(resolveMetadata(opts, cat, models, 'big')?.contextWindow).toBe(40960)
  })

  test('a live entry with no context window falls through to guess (default chain)', () => {
    // Reproduces the DEFAULT discover chain (`auto` -> openai-models-list, guess),
    // as every openai-compatible provider gets when unconfigured. NVIDIA-style
    // endpoints emit a bare {name} liveMeta entry (no contextWindow) — that must
    // not out-rank `guess`, which knows gpt-oss-120b's real limits.
    const opts = base(['auto'])
    const models = cerebrasModels()
    const cat = buildCatalog(opts, models, '/tmp', new Map())
    cat.addresses.add('nv/gpt-oss-120b')
    cat.leafFor.set('nv/gpt-oss-120b', 'nv/gpt-oss-120b')
    cat.liveMeta.set('nv/gpt-oss-120b', { name: 'gpt-oss-120b' })
    const meta = resolveMetadata(opts, cat, models, 'nv/gpt-oss-120b')
    expect(meta?.contextWindow).toBeGreaterThan(0)
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
  // Deliberately per-million values sent as strings: string-ness and unit are
  // independent, which is why the unit heuristic must not key off the type.
  test('numeric string pricing fields are coerced', () => {
    const payload = {
      data: [{ id: 'some/model', pricing: { prompt: '0.1', completion: '0.4' } }]
    }
    const m = parseOpenaiModelsList(payload).get('some/model')!
    expect(m.cost).toEqual({ input: 0.1, output: 0.4 })
  })
})

// chutes quotes per-million USD in `pricing.prompt`; OpenRouter quotes per-token
// in the same field. Magnitude, not type, tells the two regimes apart.
describe('parseOpenaiModelsList pricing units', () => {
  const listPayload = (entry: Record<string, unknown>) => ({ data: [{ id: 'm', ...entry }] })

  test('leaves per-million pricing alone', () => {
    const out = parseOpenaiModelsList(
      listPayload({ pricing: { prompt: 0.104, completion: 0.416 } })
    )
    expect(out.get('m')?.cost).toEqual({ input: 0.104, output: 0.416 })
  })

  test('scales per-token pricing to per-million', () => {
    const out = parseOpenaiModelsList(
      listPayload({ pricing: { prompt: '0.0000001', completion: '0.0000002' } })
    )
    expect(out.get('m')?.cost).toEqual({ input: 0.1, output: 0.2 })
  })

  test('decides the unit once per model, not per field', () => {
    const out = parseOpenaiModelsList(
      listPayload({ pricing: { prompt: 0, completion: '0.0000002' } })
    )
    expect(out.get('m')?.cost).toEqual({ input: 0, output: 0.2 })
  })

  test('a model with only zero pricing is left at zero', () => {
    const out = parseOpenaiModelsList(listPayload({ pricing: { prompt: 0, completion: 0 } }))
    expect(out.get('m')?.cost).toEqual({ input: 0, output: 0 })
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

// Bare openai-compatible model fixture, shared by the layer-0/guess tests below.
// contextWindow 0 mirrors nvidia's catalog entries; a real value mirrors openrouter's.
const fakeModel = (provider: string, id: string, contextWindow: number) => ({
  id,
  name: id,
  api: 'openai-completions' as const,
  provider,
  baseUrl: 'https://example.test/v1',
  reasoning: false,
  input: ['text' as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow,
  maxTokens: 0
})

// nvidia provider with a `guess` discover chain, and the leaf address wired
// through the catalog — shared by the resolveMetadata layer-0 tests below.
const nvidiaGuessFixture = () => ({
  options: {
    providers: {
      nvidia: {
        type: 'openai-compatible',
        baseUrl: 'https://example.test/v1',
        discover: ['guess'],
        account: { credential: 'key', name: 'nvidia', key: 'k' }
      }
    },
    pipeline: [],
    expose: [],
    server: {}
  } as unknown as RouterOptions,
  catalog: {
    addresses: new Set(['nvidia/moonshotai/kimi-k2.6']),
    leafFor: new Map([['nvidia/moonshotai/kimi-k2.6', 'nvidia/moonshotai/kimi-k2.6']]),
    liveMeta: new Map(),
    available: new Set(['nvidia'])
  }
})

// Same shape as fakeModel, but with a real (non-zero) cost — mirrors a paid
// vendor like openrouter, so it can stand in contrast to nvidia's free tier.
const pricedModel = (
  provider: string,
  id: string,
  contextWindow: number,
  input: number,
  output: number
) => ({
  ...fakeModel(provider, id, contextWindow),
  cost: { input, output, cacheRead: 0, cacheWrite: 0 }
})

test('guess borrows limits from a same-named model but never its cost', () => {
  // nvidia (free-tier, NIM) hasn't described this model; openrouter (paid) has.
  // guess may borrow openrouter's contextWindow, but must not attribute
  // openrouter's price to an address that is actually nvidia's.
  const bare = fakeModel('nvidia', 'moonshotai/kimi-k2.6', 0)
  const priced = pricedModel('openrouter', 'moonshotai/kimi-k2.6', 262_144, 2, 8)
  const models = { getModels: () => [bare, priced] } as unknown as Models

  const meta = guessFromCatalog(models, 'nvidia/moonshotai/kimi-k2.6')
  expect(meta?.contextWindow).toBe(262_144)
  expect(meta?.cost).toBeUndefined()
})

test('a model with no known context window cannot be a guess source', () => {
  // The limit-less entry is registered FIRST, so first-write-wins would pick it.
  const models = {
    getModels: () => [
      fakeModel('nvidia', 'moonshotai/kimi-k2.6', 0),
      fakeModel('openrouter', 'moonshotai/kimi-k2.6', 262_144)
    ]
  } as unknown as Models

  expect(guessFromCatalog(models, 'nvidia/moonshotai/kimi-k2.6')?.contextWindow).toBe(262_144)
})

test('a catalog entry with no limits still consults the discover chain', () => {
  const bare = fakeModel('nvidia', 'moonshotai/kimi-k2.6', 0)
  const rich = fakeModel('openrouter', 'moonshotai/kimi-k2.6', 262_144)
  const models = {
    getModels: () => [bare, rich],
    getModel: (provider: string) => (provider === 'nvidia' ? bare : rich)
  } as unknown as Models

  const { options, catalog } = nvidiaGuessFixture()
  const meta = resolveMetadata(options, catalog, models, 'nvidia/moonshotai/kimi-k2.6')
  expect(meta?.contextWindow).toBe(262_144)
})

test('a catalog entry with a known context window wins over the discover chain', () => {
  // Inverse of the test above: nvidia's own entry is authoritative here (real
  // contextWindow), so layer 0 must short-circuit and never consult `guess`.
  // openrouter is listed FIRST in getModels() so that, were layer 0 ever
  // bypassed, first-write-wins would hand `guess` openrouter's 262_144 instead
  // of nvidia's own 111_111 — making the two paths distinguishable.
  const nvidia = fakeModel('nvidia', 'moonshotai/kimi-k2.6', 111_111)
  const openrouter = fakeModel('openrouter', 'moonshotai/kimi-k2.6', 262_144)
  const models = {
    getModels: () => [openrouter, nvidia],
    getModel: (provider: string) => (provider === 'nvidia' ? nvidia : openrouter)
  } as unknown as Models

  const { options, catalog } = nvidiaGuessFixture()
  const meta = resolveMetadata(options, catalog, models, 'nvidia/moonshotai/kimi-k2.6')
  expect(meta?.contextWindow).toBe(111_111)
})

// `Model` cannot express "no price", so the catalog wrapper defaults an unstated
// cost to 0 — which reads as free. The live map holds the un-defaulted parse.
describe('resolveMetadata cost presence', () => {
  test('a live entry without a cost key strips the defaulted zero price', () => {
    const nvidia = fakeModel('nvidia', 'moonshotai/kimi-k2.6', 111_111)
    const models = { getModels: () => [nvidia], getModel: () => nvidia } as unknown as Models

    const { options, catalog } = nvidiaGuessFixture()
    catalog.liveMeta.set('nvidia/moonshotai/kimi-k2.6', {
      name: 'kimi',
      contextWindow: 111_111
    })
    const meta = resolveMetadata(options, catalog, models, 'nvidia/moonshotai/kimi-k2.6')
    expect(nvidia.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(meta?.contextWindow).toBe(111_111)
    expect(meta?.cost).toBeUndefined()
  })

  test('a live entry stating a zero cost still reads as free', () => {
    const nvidia = fakeModel('nvidia', 'moonshotai/kimi-k2.6', 111_111)
    const models = { getModels: () => [nvidia], getModel: () => nvidia } as unknown as Models

    const { options, catalog } = nvidiaGuessFixture()
    catalog.liveMeta.set('nvidia/moonshotai/kimi-k2.6', {
      name: 'kimi',
      contextWindow: 111_111,
      cost: { input: 0, output: 0 }
    })
    const meta = resolveMetadata(options, catalog, models, 'nvidia/moonshotai/kimi-k2.6')
    expect(meta?.cost?.input).toBe(0)
    expect(meta?.cost?.output).toBe(0)
  })

  test('an address absent from the live map keeps layer 0s cost', () => {
    // The "no catalog was ever stored" case: nothing contradicts layer 0, so the
    // rule must not fire.
    const nvidia = pricedModel('nvidia', 'moonshotai/kimi-k2.6', 111_111, 2, 8)
    const models = { getModels: () => [nvidia], getModel: () => nvidia } as unknown as Models

    const { options, catalog } = nvidiaGuessFixture()
    const meta = resolveMetadata(options, catalog, models, 'nvidia/moonshotai/kimi-k2.6')
    expect(meta?.cost?.input).toBe(2)
    expect(meta?.cost?.output).toBe(8)
  })
})

test('fetchProviderMetadata gives up on a hung endpoint instead of hanging', async () => {
  const original = globalThis.fetch
  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })) as typeof fetch

  try {
    const result = await fetchProviderMetadata(
      'nvidia',
      {
        type: 'openai-compatible',
        baseUrl: 'https://example.test/v1',
        discover: ['openai-models-list'],
        account: { credential: 'key', key: 'k' }
      } as never,
      50
    )
    expect(result.size).toBe(0)
  } finally {
    globalThis.fetch = original
  }
})

// enrichLiveMeta covers only what the catalog wrapper does not. Counting fetches
// is the whole point here: a provider recorded in the build-time `wrapped` set is
// already fetched and published by that wrapper, so a second GET would be a request
// for data we already hold — while every provider NOT in `wrapped` must keep its
// live metadata. Headers are captured alongside the urls: for a disabled account
// the claim is not merely "fewer requests" but "the key never left the process".
const countingFetch = (): {
  calls: string[]
  headers: Record<string, string>[]
  fetch: typeof fetch
} => {
  const calls: string[] = []
  const headers: Record<string, string>[] = []
  return {
    calls,
    headers,
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push(String(url))
      headers.push((init?.headers ?? {}) as Record<string, string>)
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }) as unknown as typeof fetch
  }
}

const emptyCatalog = () =>
  ({
    addresses: new Set<string>(),
    leafFor: new Map<string, string>(),
    liveMeta: new Map(),
    available: new Set<string>()
  }) as unknown as Parameters<typeof enrichLiveMeta>[1]

const enrichWith = async (
  providers: Record<string, unknown>,
  wrapped: string[] = []
): Promise<{ calls: string[]; headers: Record<string, string>[] }> => {
  const original = globalThis.fetch
  const { calls, headers, fetch: stub } = countingFetch()
  globalThis.fetch = stub
  try {
    await enrichLiveMeta(
      { providers, pipeline: [], expose: [] } as unknown as RouterOptions,
      emptyCatalog(),
      new Set(wrapped)
    )
    return { calls, headers }
  } finally {
    globalThis.fetch = original
  }
}

describe('enrichLiveMeta', () => {
  // "Off means off": a disabled account's key must not reach its own endpoint,
  // on boot or on any rebuild. See wrapProvider in src/models/build.ts.
  test('sends nothing at all for a disabled provider — not even an unauthenticated GET', async () => {
    const { calls, headers } = await enrichWith({
      chutes: {
        type: 'openai-compatible',
        baseUrl: 'https://example.test/v1',
        discover: ['openai-models-list'],
        account: { credential: 'key', key: 'k', disabled: true }
      }
    })
    expect(calls).toEqual([])
    expect(headers.flatMap((h) => Object.keys(h))).not.toContain('authorization')
  })

  // An oauth-credential openai-compatible provider is wrapped but never refreshed
  // (buildOne gives it an apiKey auth only, so pi-ai resolves no refresh
  // credential), so the wrapper never publishes for it — and this fallback must.
  test('still fetches for an oauth-credential provider nothing has published for', async () => {
    const { calls } = await enrichWith({
      oa: {
        type: 'openai-compatible',
        baseUrl: 'https://example.test/v1',
        discover: ['openai-models-list'],
        account: { credential: 'oauth', name: 'openai-compatible-acct' }
      }
    })
    expect(calls).toEqual(['https://example.test/v1/models'])
  })

  test('still fetches /model/info for a litellm provider even when wrapped (no wrapper reads that endpoint)', async () => {
    const { calls } = await enrichWith(
      {
        proxy: {
          type: 'openai-compatible',
          baseUrl: 'https://example.test/v1',
          discover: ['litellm'],
          account: { credential: 'key', key: 'k' }
        }
      },
      ['proxy']
    )
    expect(calls).toEqual(['https://example.test/v1/model/info'])
  })

  // A type the Models collection doesn't back is never wrapped (buildOne returns
  // undefined, so it dispatches passthrough) — its live metadata has no other source.
  test('still fetches /models for a passthrough-typed provider the wrapper never wraps', async () => {
    const { calls } = await enrichWith({
      weird: {
        type: 'some-proxy',
        baseUrl: 'https://example.test/v1',
        discover: ['openai-models-list'],
        account: { credential: 'key', key: 'k' }
      }
    })
    expect(calls).toEqual(['https://example.test/v1/models'])
  })
})

describe('enrichLiveMeta', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  const opts = {
    providers: {
      covered: {
        type: 'openai-compatible',
        baseUrl: 'https://cov/v1',
        account: { credential: 'key', key: 'k' },
        discover: ['openai-models-list']
      },
      bare: {
        type: 'openai-compatible',
        baseUrl: 'https://bare/v1',
        account: { credential: 'key', key: 'k' },
        discover: ['openai-models-list']
      }
    },
    pipeline: [],
    expose: []
  } as unknown as RouterOptions

  test('skips a wrapped provider and re-fetches an uncovered one every call', async () => {
    const calls: Record<string, number> = {}
    globalThis.fetch = (async (url: string) => {
      const host = new URL(url).host
      calls[host] = (calls[host] ?? 0) + 1
      return Response.json({ data: [{ id: 'm', context_length: 8000 }] })
    }) as typeof fetch

    const catalog: Catalog = {
      addresses: new Set<string>(),
      leafFor: new Map(),
      liveMeta: new Map(),
      available: new Set<string>()
    }
    const wrapped = new Set(['covered'])

    await enrichLiveMeta(opts, catalog, wrapped)
    await enrichLiveMeta(opts, catalog, wrapped)

    expect(calls.cov).toBeUndefined() // wrapped → never fetched
    expect(calls.bare).toBe(2) // uncovered → fetched both times (no staleness)
    expect(catalog.liveMeta.get('bare/m')?.contextWindow).toBe(8000)
  })
})
