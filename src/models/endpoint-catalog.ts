import type { Api, Model, Provider, RefreshModelsContext } from '@earendil-works/pi-ai'

import type { ModelMeta } from '../pipeline/catalog'
import { parseOpenaiModelsList } from '../pipeline/metadata'
import { mergeModels, REFRESH_INTERVAL_MS } from './remote-catalog'

// A hung endpoint (connection accepted, headers never sent) must not wedge
// this provider's refresh forever — pi-ai's Models.refresh() awaits every
// provider with Promise.all, so one stuck fetch blocks the catalog rebuild
// for every provider, and `inflight` never clears to let a later tick retry.
const ENDPOINT_FETCH_TIMEOUT_MS = 30_000

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

export type EndpointCatalogOpts = {
  apiKey?: string
  now?: () => number
  fetcher?: Fetcher
  timeoutMs?: number
}

// `0` means "the endpoint did not say" — for the numeric limits (contextWindow,
// maxTokens) and cost fields, which readers treat as unknown rather than fact
// (see buildGuessIndex, resolveMetadata layer 0, and createModelsDispatch).
// `reasoning` and `input` have no such sentinel: `Model` requires them, so
// `reasoning: false` / `input: ['text']` are asserted as fact here, and
// resolveMetadata's all-or-nothing discover chain will never revisit them
// once layer 0 returns non-null.
const toModel = (providerId: string, baseUrl: string, id: string, meta: ModelMeta): Model<Api> => ({
  id,
  name: meta.name,
  api: 'openai-completions',
  provider: providerId,
  baseUrl,
  reasoning: meta.reasoning ?? false,
  input: (meta.input ?? ['text']).filter(
    (m): m is 'text' | 'image' => m === 'text' || m === 'image'
  ),
  cost: {
    input: meta.cost?.input ?? 0,
    output: meta.cost?.output ?? 0,
    cacheRead: meta.cost?.cacheRead ?? 0,
    cacheWrite: meta.cost?.cacheWrite ?? 0
  },
  contextWindow: meta.contextWindow ?? 0,
  maxTokens: meta.maxTokens ?? 0
})

// Populate an openai-compatible provider's catalog from its own GET /models.
// Mirrors withRemoteCatalog: same store, same 4 h interval, same in-flight sharing,
// same id-keyed merge, failures logged and swallowed so a dead endpoint never
// breaks a boot.
export const withEndpointCatalog = (
  provider: Provider,
  opts: EndpointCatalogOpts = {}
): Provider => {
  const now = opts.now ?? Date.now
  const fetcher = opts.fetcher ?? fetch
  const baseUrl = provider.baseUrl ?? ''
  let fetched: readonly Model<Api>[] = []
  let inflight: Promise<void> | undefined

  return {
    ...provider,
    getModels: () => mergeModels(provider.getModels(), fetched),
    refreshModels: (context: RefreshModelsContext) => {
      inflight ??= (async () => {
        try {
          const cache = await context.store.read()
          if (cache) {
            fetched = Array.isArray(cache.models)
              ? cache.models.filter(
                  (m): m is Model<Api> =>
                    typeof m === 'object' && m !== null && 'id' in m && typeof m.id === 'string'
                )
              : []
          }
          if (!context.allowNetwork || context.signal?.aborted) return
          if (
            !context.force &&
            cache?.checkedAt !== undefined &&
            now() - cache.checkedAt < REFRESH_INTERVAL_MS
          ) {
            return
          }
          const timeout = AbortSignal.timeout(opts.timeoutMs ?? ENDPOINT_FETCH_TIMEOUT_MS)
          const response = await fetcher(`${baseUrl}/models`, {
            headers: {
              accept: 'application/json',
              ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {})
            },
            signal: context.signal ? AbortSignal.any([context.signal, timeout]) : timeout
          })
          if (!response.ok) throw new Error(`${baseUrl}/models → ${response.status}`)
          const payload = await response.json()
          if (context.signal?.aborted) return
          fetched = [...parseOpenaiModelsList(payload)].map(([id, meta]) =>
            toModel(provider.id, baseUrl, id, meta)
          )
          await context.store.write({ models: fetched, checkedAt: now() })
        } catch (err) {
          console.error(`[endpoint-catalog] refresh failed for "${provider.id}": ${String(err)}`)
        } finally {
          inflight = undefined
        }
      })()
      return inflight
    }
  }
}
