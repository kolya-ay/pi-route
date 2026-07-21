import { describe, expect, test } from 'bun:test'
import type { Provider } from '@earendil-works/pi-ai'
import { InMemoryModelsStore } from '@earendil-works/pi-ai'
import { withEndpointCatalog } from './endpoint-catalog'

const fakeProvider = (id = 'nvidia'): Provider =>
  ({ id, name: id, baseUrl: 'https://example.test/v1', getModels: () => [] }) as unknown as Provider

const providerStore = (store: InMemoryModelsStore, id: string) => ({
  read: () => store.read(id),
  write: (e: Parameters<InMemoryModelsStore['write']>[1]) => store.write(id, e),
  delete: () => store.delete(id)
})

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
    const wrapped = withEndpointCatalog(fakeProvider(), {
      now: () => 1000,
      timeoutMs: 20,
      // Mirrors real fetch: never resolves on its own, but rejects when its
      // signal aborts — exactly what withEndpointCatalog must supply a timeout
      // signal for, since a truly inert stub would hang regardless of any fix.
      fetcher: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        })
    })
    await wrapped.refreshModels?.({ store: providerStore(store, 'nvidia'), allowNetwork: true })
    expect(await store.read('nvidia')).toBeUndefined()
    expect(wrapped.getModels()).toEqual([])
  }, 2000)
})
