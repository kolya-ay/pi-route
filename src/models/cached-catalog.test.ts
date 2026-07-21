import { describe, expect, test } from 'bun:test'
import type { Provider } from '@earendil-works/pi-ai'
import { InMemoryModelsStore } from '@earendil-works/pi-ai'
import type { ModelMeta } from '../pipeline/catalog'
import { withEndpointCatalog, withRemoteCatalog } from './cached-catalog'

const providerStore = (store: InMemoryModelsStore, id: string) => ({
  read: () => store.read(id),
  write: (e: Parameters<InMemoryModelsStore['write']>[1]) => store.write(id, e),
  delete: () => store.delete(id)
})

const baseModel = (id: string, provider = 'cc') => ({
  id,
  name: id,
  api: 'anthropic-messages' as const,
  provider,
  baseUrl: 'https://api.anthropic.com',
  reasoning: false,
  input: ['text' as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 64000
})

const staticProvider = (): Provider =>
  ({
    id: 'cc',
    name: 'cc',
    auth: { apiKey: { name: 'k', resolve: async () => undefined } },
    getModels: () => [baseModel('old-model')],
    stream: () => {
      throw new Error('unused')
    },
    streamSimple: () => {
      throw new Error('unused')
    }
  }) as unknown as Provider

const storeFor = () => new InMemoryModelsStore()

describe('withRemoteCatalog', () => {
  test('merges fetched models over static, re-stamped to config id', async () => {
    const store = storeFor()
    const fetched = { models: [{ ...baseModel('new-model', 'anthropic') }] }
    const wrapped = withRemoteCatalog(staticProvider(), 'anthropic', {
      now: () => 1000,
      fetcher: async () => new Response(JSON.stringify(fetched))
    })
    await wrapped.refreshModels?.({
      store: providerStore(store, 'cc'),
      allowNetwork: true
    })
    const ids = wrapped
      .getModels()
      .map((m) => m.id)
      .sort()
    expect(ids).toEqual(['new-model', 'old-model'])
    expect(wrapped.getModels().every((m) => m.provider === 'cc')).toBe(true)
    expect((await store.read('cc'))?.checkedAt).toBe(1000)
  })

  test('within freshness window: restores from store, skips network', async () => {
    const store = storeFor()
    await store.write('cc', { models: [baseModel('stored-model')], checkedAt: 1000 })
    let calls = 0
    const wrapped = withRemoteCatalog(staticProvider(), 'anthropic', {
      now: () => 1000 + 60_000,
      fetcher: async () => {
        calls += 1
        return new Response('{}')
      }
    })
    await wrapped.refreshModels?.({ store: providerStore(store, 'cc'), allowNetwork: true })
    expect(calls).toBe(0)
    expect(wrapped.getModels().map((m) => m.id)).toContain('stored-model')
  })

  test('fetch failure keeps previous list', async () => {
    const store = storeFor()
    await store.write('cc', { models: [baseModel('stored-model')], checkedAt: 0 })
    const wrapped = withRemoteCatalog(staticProvider(), 'anthropic', {
      now: () => 999_999_999,
      fetcher: async () => new Response('boom', { status: 500 })
    })
    await wrapped.refreshModels?.({ store: providerStore(store, 'cc'), allowNetwork: true })
    expect(wrapped.getModels().map((m) => m.id)).toContain('stored-model')
  })

  test('a wrong-shape 200 does not persist an empty catalog', async () => {
    const store = storeFor()
    const wrapped = withRemoteCatalog(staticProvider(), 'anthropic', {
      now: () => 1000,
      fetcher: async () => new Response(JSON.stringify({ error: 'rate limited' }))
    })
    await wrapped.refreshModels?.({ store: providerStore(store, 'cc'), allowNetwork: true })
    expect(wrapped.getModels().map((m) => m.id)).toEqual(['old-model'])
    expect(await store.read('cc')).toBeUndefined()
  })

  test('a stored entry whose id is not a string is dropped', async () => {
    const store = storeFor()
    await store.write('cc', {
      models: [{ ...baseModel('x'), id: 123 }],
      checkedAt: 1000
    } as unknown as Parameters<InMemoryModelsStore['write']>[1])
    const wrapped = withRemoteCatalog(staticProvider(), 'anthropic', {
      now: () => 1000,
      fetcher: async () => new Response('{}')
    })
    await wrapped.refreshModels?.({ store: providerStore(store, 'cc'), allowNetwork: true })
    expect(wrapped.getModels().map((m) => m.id)).toEqual(['old-model'])
  })

  test('aborts the pi.dev fetch when it exceeds the timeout', async () => {
    const store = storeFor()
    let seenSignal: AbortSignal | undefined
    const wrapped = withRemoteCatalog(staticProvider(), 'anthropic', {
      timeoutMs: 10,
      fetcher: (_url, init) => {
        seenSignal = init?.signal ?? undefined
        // Mirrors real fetch: never resolves on its own, but rejects when its
        // signal aborts. If the deadline signal ever stops being supplied, fail
        // by name here rather than hanging until bun's default test budget.
        if (!init?.signal) {
          return Promise.reject(new Error('fetch called without an abort signal'))
        }
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        })
      }
    })
    await wrapped.refreshModels?.({
      store: providerStore(store, 'cc'),
      allowNetwork: true
    })
    expect(seenSignal?.aborted).toBe(true)
    // No caller signal to compose with, so the bare deadline is what fired.
    expect((seenSignal?.reason as Error | undefined)?.name).toBe('TimeoutError')
    expect(await store.read('cc')).toBeUndefined()
  }, 2000)
})

const fakeProvider = (id = 'nvidia'): Provider =>
  ({ id, name: id, baseUrl: 'https://example.test/v1', getModels: () => [] }) as unknown as Provider

// nvidia-shaped: ids only, no limits or pricing.
const bareList = {
  data: [
    { id: 'qwen/qwen3.5-122b-a10b', object: 'model', owned_by: 'qwen' },
    { id: 'moonshotai/kimi-k2.6', object: 'model', owned_by: 'moonshotai' }
  ]
}

// chutes-shaped: full metadata.
const richList = {
  data: [
    {
      id: 'zai-org/GLM-5.2-TEE',
      context_length: 1_000_000,
      max_output_length: 131_072,
      pricing: { prompt: 0.91, completion: 2.86 },
      input_modalities: ['text', 'image']
    }
  ]
}

describe('withEndpointCatalog', () => {
  test('fetched ids become models, with 0 marking limits the endpoint omitted', async () => {
    const store = new InMemoryModelsStore()
    const wrapped = withEndpointCatalog(fakeProvider(), {
      now: () => 1000,
      fetcher: async () => new Response(JSON.stringify(bareList))
    })
    await wrapped.refreshModels?.({ store: providerStore(store, 'nvidia'), allowNetwork: true })

    const models = wrapped.getModels()
    expect(models.map((m) => m.id).sort()).toEqual([
      'moonshotai/kimi-k2.6',
      'qwen/qwen3.5-122b-a10b'
    ])
    expect(models.every((m) => m.provider === 'nvidia')).toBe(true)
    expect(models[0]?.contextWindow).toBe(0)
    expect(models[0]?.maxTokens).toBe(0)
    expect((await store.read('nvidia'))?.checkedAt).toBe(1000)
  })

  test('metadata the endpoint does serve is carried onto the model', async () => {
    const store = new InMemoryModelsStore()
    const wrapped = withEndpointCatalog(fakeProvider('chutes'), {
      now: () => 1000,
      fetcher: async () => new Response(JSON.stringify(richList))
    })
    await wrapped.refreshModels?.({ store: providerStore(store, 'chutes'), allowNetwork: true })

    const model = wrapped.getModels()[0]
    expect(model?.contextWindow).toBe(1_000_000)
    expect(model?.maxTokens).toBe(131_072)
    expect(model?.cost.input).toBe(0.91)
    expect(model?.cost.output).toBe(2.86)
    expect(model?.input).toEqual(['text', 'image'])
  })

  test('requests carry the resolved api key', async () => {
    const store = new InMemoryModelsStore()
    let seen: string | null = null
    const wrapped = withEndpointCatalog(fakeProvider(), {
      apiKey: 'secret-key',
      now: () => 1000,
      fetcher: async (_url, init) => {
        seen = new Headers(init?.headers).get('authorization')
        return new Response(JSON.stringify(bareList))
      }
    })
    await wrapped.refreshModels?.({ store: providerStore(store, 'nvidia'), allowNetwork: true })
    // tsgo (native preview) mis-narrows `seen` to `null` across the awaited
    // closure that assigns it; cast keeps the runtime assertion unchanged.
    expect(seen as string | null).toBe('Bearer secret-key')
  })

  test('a fresh cache entry suppresses the fetch, force overrides it', async () => {
    const store = new InMemoryModelsStore()
    let calls = 0
    const fetcher = async () => {
      calls += 1
      return new Response(JSON.stringify(bareList))
    }
    const wrapped = withEndpointCatalog(fakeProvider(), { now: () => 1000, fetcher })
    const ctx = { store: providerStore(store, 'nvidia'), allowNetwork: true }

    await wrapped.refreshModels?.(ctx)
    expect(calls).toBe(1)
    await wrapped.refreshModels?.(ctx)
    expect(calls).toBe(1)
    await wrapped.refreshModels?.({ ...ctx, force: true })
    expect(calls).toBe(2)
  })

  test('allowNetwork false serves the store without fetching', async () => {
    const store = new InMemoryModelsStore()
    let calls = 0
    const seeded = withEndpointCatalog(fakeProvider(), {
      now: () => 1000,
      fetcher: async () => {
        calls += 1
        return new Response(JSON.stringify(bareList))
      }
    })
    await seeded.refreshModels?.({ store: providerStore(store, 'nvidia'), allowNetwork: true })
    expect(calls).toBe(1)

    const offline = withEndpointCatalog(fakeProvider(), {
      now: () => 9_999_999_999,
      fetcher: async () => {
        calls += 1
        return new Response(JSON.stringify(bareList))
      }
    })
    await offline.refreshModels?.({ store: providerStore(store, 'nvidia'), allowNetwork: false })
    expect(calls).toBe(1)
    expect(offline.getModels().length).toBe(2)
  })

  test('a failed fetch leaves previously known models intact and does not throw', async () => {
    const store = new InMemoryModelsStore()
    const wrapped = withEndpointCatalog(fakeProvider(), {
      now: () => 1000,
      fetcher: async () => new Response(JSON.stringify(bareList))
    })
    await wrapped.refreshModels?.({ store: providerStore(store, 'nvidia'), allowNetwork: true })
    expect(wrapped.getModels().length).toBe(2)

    const later = withEndpointCatalog(fakeProvider(), {
      now: () => 9_999_999_999,
      fetcher: async () => new Response('nope', { status: 500 })
    })
    await later.refreshModels?.({ store: providerStore(store, 'nvidia'), allowNetwork: true })
    expect(later.getModels().length).toBe(2)
  })

  test('a wrong-shape 200 (e.g. a rate-limit error body) leaves previously known models and the stored entry intact', async () => {
    const store = new InMemoryModelsStore()
    const wrapped = withEndpointCatalog(fakeProvider(), {
      now: () => 1000,
      fetcher: async () => new Response(JSON.stringify(bareList))
    })
    await wrapped.refreshModels?.({ store: providerStore(store, 'nvidia'), allowNetwork: true })
    expect(wrapped.getModels().length).toBe(2)

    const later = withEndpointCatalog(fakeProvider(), {
      now: () => 9_999_999_999,
      // 200 OK, but not the { data: [...] } shape — dataArray() parses this to [].
      fetcher: async () => new Response(JSON.stringify({ error: 'rate limited' }))
    })
    await later.refreshModels?.({ store: providerStore(store, 'nvidia'), allowNetwork: true })
    expect(later.getModels().length).toBe(2)
    expect((await store.read('nvidia'))?.models.length).toBe(2)
  })

  test('a wrong-shape 200 on a cold (empty) cache does not persist an empty catalog', async () => {
    // Distinct from the warm-cache case above: nothing was ever fetched
    // successfully before, so there is nothing to "protect" in memory — but
    // writing {models: [], checkedAt: now} here would still be wrong, because
    // it would pass the freshness check on the next boot and hide the
    // provider for a full REFRESH_INTERVAL_MS window with no way to tell a
    // genuine empty catalog from a mis-shaped 200.
    const store = new InMemoryModelsStore()
    const wrapped = withEndpointCatalog(fakeProvider(), {
      now: () => 1000,
      fetcher: async () => new Response(JSON.stringify({ error: 'rate limited' }))
    })
    await wrapped.refreshModels?.({ store: providerStore(store, 'nvidia'), allowNetwork: true })
    expect(wrapped.getModels()).toEqual([])
    expect(await store.read('nvidia')).toBeUndefined()
  })

  test('a malformed cache entry degrades to no models rather than crashing', async () => {
    const store = new InMemoryModelsStore()
    await store.write('nvidia', { checkedAt: 1000 } as unknown as Parameters<
      InMemoryModelsStore['write']
    >[1])
    const wrapped = withEndpointCatalog(fakeProvider(), {
      now: () => 1000,
      fetcher: async () => new Response(JSON.stringify(bareList))
    })
    await wrapped.refreshModels?.({ store: providerStore(store, 'nvidia'), allowNetwork: true })
    expect(wrapped.getModels()).toEqual([])
  })

  test('malformed entries within an otherwise valid cache array are dropped', async () => {
    const store = new InMemoryModelsStore()
    await store.write('nvidia', {
      models: [null, 'x', { notAModel: true }],
      checkedAt: 1000
    } as unknown as Parameters<InMemoryModelsStore['write']>[1])
    const wrapped = withEndpointCatalog(fakeProvider(), {
      now: () => 1000,
      fetcher: async () => new Response(JSON.stringify(bareList))
    })
    await wrapped.refreshModels?.({ store: providerStore(store, 'nvidia'), allowNetwork: true })
    expect(wrapped.getModels()).toEqual([])
  })

  test('entries whose id is not a string are dropped', async () => {
    const store = new InMemoryModelsStore()
    await store.write('nvidia', {
      models: [{ id: 123 }, { id: null }],
      checkedAt: 1000
    } as unknown as Parameters<InMemoryModelsStore['write']>[1])
    const wrapped = withEndpointCatalog(fakeProvider(), {
      now: () => 1000,
      fetcher: async () => new Response(JSON.stringify(bareList))
    })
    await wrapped.refreshModels?.({ store: providerStore(store, 'nvidia'), allowNetwork: true })
    expect(wrapped.getModels()).toEqual([])
  })

  test('concurrent callers share one in-flight refresh', async () => {
    const store = new InMemoryModelsStore()
    let calls = 0
    const wrapped = withEndpointCatalog(fakeProvider(), {
      now: () => 1000,
      fetcher: async () => {
        calls += 1
        return new Response(JSON.stringify(bareList))
      }
    })
    const ctx = { store: providerStore(store, 'nvidia'), allowNetwork: true }
    await Promise.all([wrapped.refreshModels?.(ctx), wrapped.refreshModels?.(ctx)])
    expect(calls).toBe(1)
  })

  test('a rejected refresh clears inflight so the next attempt still fetches', async () => {
    const store = new InMemoryModelsStore()
    let calls = 0
    const wrapped = withEndpointCatalog(fakeProvider(), {
      now: () => 1000,
      fetcher: async () => {
        calls += 1
        return new Response('nope', { status: 500 })
      }
    })
    const ctx = { store: providerStore(store, 'nvidia'), allowNetwork: true }
    await wrapped.refreshModels?.(ctx)
    expect(calls).toBe(1)
    await wrapped.refreshModels?.(ctx)
    expect(calls).toBe(2)
  })

  test('a signal aborted before the fetch leaves the store unwritten', async () => {
    const store = new InMemoryModelsStore()
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    const wrapped = withEndpointCatalog(fakeProvider(), {
      now: () => 1000,
      fetcher: async () => {
        calls += 1
        return new Response(JSON.stringify(bareList))
      }
    })
    await wrapped.refreshModels?.({
      store: providerStore(store, 'nvidia'),
      allowNetwork: true,
      signal: controller.signal
    })
    expect(calls).toBe(0)
    expect(await store.read('nvidia')).toBeUndefined()
  })

  test('a signal aborted after the fetch resolves leaves the store unwritten', async () => {
    const store = new InMemoryModelsStore()
    const controller = new AbortController()
    const wrapped = withEndpointCatalog(fakeProvider(), {
      now: () => 1000,
      fetcher: async () => {
        controller.abort()
        return new Response(JSON.stringify(bareList))
      }
    })
    await wrapped.refreshModels?.({
      store: providerStore(store, 'nvidia'),
      allowNetwork: true,
      signal: controller.signal
    })
    expect(await store.read('nvidia')).toBeUndefined()
    expect(wrapped.getModels()).toEqual([])
  })

  test('a hung fetch settles instead of blocking forever, leaving the store unwritten', async () => {
    const store = new InMemoryModelsStore()
    let seenSignal: AbortSignal | undefined
    const wrapped = withEndpointCatalog(fakeProvider(), {
      now: () => 1000,
      timeoutMs: 20,
      // Mirrors real fetch: never resolves on its own, but rejects when its
      // signal aborts — exactly what withEndpointCatalog must supply a timeout
      // signal for, since a truly inert stub would hang regardless of any fix.
      fetcher: (_url, init) => {
        seenSignal = init?.signal ?? undefined
        if (!init?.signal) {
          return Promise.reject(new Error('fetch called without an abort signal'))
        }
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        })
      }
    })
    await wrapped.refreshModels?.({ store: providerStore(store, 'nvidia'), allowNetwork: true })
    // No caller signal to compose with, so the bare deadline is what fired.
    expect((seenSignal?.reason as Error | undefined)?.name).toBe('TimeoutError')
    expect(await store.read('nvidia')).toBeUndefined()
    expect(wrapped.getModels()).toEqual([])
  }, 2000)
})

// What the store holds beyond `models`: the lossless parse, kept so a later
// reader can tell "the endpoint said 0" from "the endpoint said nothing".
const storedMeta = async (store: InMemoryModelsStore, id: string) =>
  (await store.read(id)) as unknown as { meta?: unknown } | undefined

describe('lossless meta', () => {
  test('a successful fetch persists meta and publishes it, with unstated fields undefined', async () => {
    const store = new InMemoryModelsStore()
    const liveMeta = new Map<string, ModelMeta>()
    const wrapped = withEndpointCatalog(fakeProvider(), {
      now: () => 1000,
      liveMeta,
      fetcher: async () => new Response(JSON.stringify(bareList))
    })
    await wrapped.refreshModels?.({ store: providerStore(store, 'nvidia'), allowNetwork: true })

    const entry = liveMeta.get('nvidia/qwen/qwen3.5-122b-a10b')
    expect(entry?.name).toBe('qwen/qwen3.5-122b-a10b')
    // The whole point: the model says 0, the meta says "not stated".
    expect(entry?.cost).toBeUndefined()
    expect(entry?.contextWindow).toBeUndefined()
    expect(wrapped.getModels().find((m) => m.id === 'qwen/qwen3.5-122b-a10b')?.contextWindow).toBe(
      0
    )

    const persisted = (await storedMeta(store, 'nvidia'))?.meta as Record<string, ModelMeta>
    expect(Object.keys(persisted).sort()).toEqual([
      'moonshotai/kimi-k2.6',
      'qwen/qwen3.5-122b-a10b'
    ])
    expect((await store.read('nvidia'))?.models.length).toBe(2)
  })

  test('stated pricing survives into the sink', async () => {
    const store = new InMemoryModelsStore()
    const liveMeta = new Map<string, ModelMeta>()
    const wrapped = withEndpointCatalog(fakeProvider('chutes'), {
      now: () => 1000,
      liveMeta,
      fetcher: async () => new Response(JSON.stringify(richList))
    })
    await wrapped.refreshModels?.({ store: providerStore(store, 'chutes'), allowNetwork: true })
    expect(liveMeta.get('chutes/zai-org/GLM-5.2-TEE')?.cost).toEqual({ input: 0.91, output: 2.86 })
  })

  test('an offline restore populates the sink from the store without fetching', async () => {
    const store = new InMemoryModelsStore()
    const seeded = withEndpointCatalog(fakeProvider('chutes'), {
      now: () => 1000,
      fetcher: async () => new Response(JSON.stringify(richList))
    })
    await seeded.refreshModels?.({ store: providerStore(store, 'chutes'), allowNetwork: true })

    const liveMeta = new Map<string, ModelMeta>()
    const offline = withEndpointCatalog(fakeProvider('chutes'), {
      now: () => 9_999_999_999,
      liveMeta,
      fetcher: async () => {
        throw new Error('offline restore must not fetch')
      }
    })
    await offline.refreshModels?.({ store: providerStore(store, 'chutes'), allowNetwork: false })
    expect(liveMeta.get('chutes/zai-org/GLM-5.2-TEE')?.cost).toEqual({ input: 0.91, output: 2.86 })
    expect(offline.getModels().length).toBe(1)
  })

  test('a stored entry written before meta existed restores models with an empty sink', async () => {
    const store = new InMemoryModelsStore()
    await store.write('nvidia', { models: [baseModel('stored-model', 'nvidia')], checkedAt: 1000 })
    const liveMeta = new Map<string, ModelMeta>()
    const wrapped = withEndpointCatalog(fakeProvider(), {
      now: () => 1000 + 60_000,
      liveMeta,
      fetcher: async () => {
        throw new Error('fresh cache must not fetch')
      }
    })
    await wrapped.refreshModels?.({ store: providerStore(store, 'nvidia'), allowNetwork: true })
    expect(wrapped.getModels().map((m) => m.id)).toEqual(['stored-model'])
    expect(liveMeta.size).toBe(0)
  })

  test('a malformed persisted meta is normalized away rather than spread', async () => {
    for (const meta of ['not-an-object', { 'a/b': 'nope', 'c/d': null, 'e/f': [1, 2] }]) {
      const store = new InMemoryModelsStore()
      await store.write('nvidia', {
        models: [baseModel('stored-model', 'nvidia')],
        meta,
        checkedAt: 1000
      } as unknown as Parameters<InMemoryModelsStore['write']>[1])
      const liveMeta = new Map<string, ModelMeta>()
      const wrapped = withEndpointCatalog(fakeProvider(), {
        now: () => 1000 + 60_000,
        liveMeta,
        fetcher: async () => {
          throw new Error('fresh cache must not fetch')
        }
      })
      await wrapped.refreshModels?.({ store: providerStore(store, 'nvidia'), allowNetwork: true })
      expect(wrapped.getModels().map((m) => m.id)).toEqual(['stored-model'])
      expect(liveMeta.size).toBe(0)
    }
  })

  test('the pi.dev path still works and writes no meta', async () => {
    const store = storeFor()
    const liveMeta = new Map<string, ModelMeta>()
    const wrapped = withRemoteCatalog(staticProvider(), 'anthropic', {
      now: () => 1000,
      liveMeta,
      fetcher: async () => new Response(JSON.stringify({ models: [baseModel('new-model')] }))
    })
    await wrapped.refreshModels?.({ store: providerStore(store, 'cc'), allowNetwork: true })
    expect(
      wrapped
        .getModels()
        .map((m) => m.id)
        .sort()
    ).toEqual(['new-model', 'old-model'])
    expect((await storedMeta(store, 'cc'))?.meta).toBeUndefined()
    expect(liveMeta.size).toBe(0)
  })
})
