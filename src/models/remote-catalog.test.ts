import { describe, expect, test } from 'bun:test'
import type { Provider } from '@earendil-works/pi-ai'
import { InMemoryModelsStore } from '@earendil-works/pi-ai'
import { withRemoteCatalog } from './remote-catalog'

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

const fakeProvider = (): Provider =>
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

const providerStore = (store: InMemoryModelsStore, id: string) => ({
  read: () => store.read(id),
  write: (e: Parameters<InMemoryModelsStore['write']>[1]) => store.write(id, e),
  delete: () => store.delete(id)
})

describe('withRemoteCatalog', () => {
  test('merges fetched models over static, re-stamped to config id', async () => {
    const store = storeFor()
    const fetched = { models: [{ ...baseModel('new-model', 'anthropic') }] }
    const wrapped = withRemoteCatalog(fakeProvider(), 'anthropic', {
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
    const wrapped = withRemoteCatalog(fakeProvider(), 'anthropic', {
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
    const wrapped = withRemoteCatalog(fakeProvider(), 'anthropic', {
      now: () => 999_999_999,
      fetcher: async () => new Response('boom', { status: 500 })
    })
    await wrapped.refreshModels?.({ store: providerStore(store, 'cc'), allowNetwork: true })
    expect(wrapped.getModels().map((m) => m.id)).toContain('stored-model')
  })

  test('aborts the pi.dev fetch when it exceeds the timeout', async () => {
    const store = storeFor()
    let seenSignal: AbortSignal | undefined
    const wrapped = withRemoteCatalog(fakeProvider(), 'anthropic', {
      timeoutMs: 10,
      fetcher: (_url, init) => {
        seenSignal = init?.signal ?? undefined
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }
    })
    await wrapped.refreshModels?.({
      store: providerStore(store, 'cc'),
      allowNetwork: true
    })
    expect(seenSignal).toBeDefined()
    expect(seenSignal?.aborted).toBe(true)
  })
})
