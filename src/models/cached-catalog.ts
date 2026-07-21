import type { Api, Model, Provider, RefreshModelsContext } from '@earendil-works/pi-ai'

import type { ModelMeta } from '../pipeline/catalog'
import { parseOpenaiModelsList } from '../pipeline/metadata'
import { FETCH_TIMEOUT_MS } from './fetch-timeout'

const CATALOG_BASE_URL = 'https://pi.dev'
export const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

export type CachedCatalogOpts = {
  now?: () => number
  fetcher?: Fetcher
  timeoutMs?: number
}

export type RemoteCatalogOpts = CachedCatalogOpts & { baseUrl?: string }

export type EndpointCatalogOpts = CachedCatalogOpts & { apiKey?: string }

// Where a catalog comes from and how to read it. Everything else — the cache,
// the freshness window, the single-flight latch, the deadline — is shared.
type CatalogSource = {
  url: string
  headers: Record<string, string>
  parse: (payload: unknown) => Model<Api>[]
}

export const mergeModels = (
  baseline: readonly Model<Api>[],
  dynamic: readonly Model<Api>[]
): Model<Api>[] => {
  const byId = new Map(baseline.map((m) => [m.id, m]))
  for (const model of dynamic) byId.set(model.id, model)
  return [...byId.values()]
}

// Both the store (read back through an unchecked cast) and a fetched payload are
// untrusted JSON: keep only objects carrying a string `id` — a numeric id would
// poison mergeModels' Map keys — and stamp the wrapping provider's (config) id
// so the rest of pi-route sees one namespace.
const toModels = (providerId: string, entries: unknown): Model<Api>[] =>
  (Array.isArray(entries) ? entries : [])
    .filter(
      (e): e is Model<Api> =>
        typeof e === 'object' && e !== null && 'id' in e && typeof e.id === 'string'
    )
    .map((m) => ({ ...m, provider: providerId }))

// pi.dev serves either a bare array or `{ models: [...] }`.
const parseCatalog = (providerId: string, value: unknown): Model<Api>[] =>
  toModels(providerId, Array.isArray(value) ? value : (value as { models?: unknown })?.models)

// `0` means "the endpoint did not say" — for the numeric limits (contextWindow,
// maxTokens) and cost fields, `Model` requires non-optional numbers so there is
// no `undefined` to fall back to. Only `contextWindow` is currently checked to
// decide whether a whole entry is authoritative (buildGuessIndex; resolveMetadata
// layers 0 and 1); `maxTokens` is honored per-field by the HTTP projections
// (model-projection.ts), which omit rather than publish a zero. Cost fields carry
// the same "0 = unknown" convention but no reader honors it yet — a defaulted
// zero cost is indistinguishable from a genuinely free model and is published as
// such (see model-projection.ts for that trade-off). `createModelsDispatch` does
// not check any of these fields yet (Task 5).
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

// Overlay a cached, periodically-refreshed dynamic catalog onto a provider's
// static one: one store entry, one 4 h interval, one in-flight refresh shared by
// concurrent callers, one id-keyed merge, failures logged and swallowed so a
// dead source never breaks a boot.
export const withCachedCatalog = (
  provider: Provider,
  source: CatalogSource,
  opts: CachedCatalogOpts = {}
): Provider => {
  const now = opts.now ?? Date.now
  const fetcher = opts.fetcher ?? fetch
  let dynamicModels: readonly Model<Api>[] = []
  let inflight: Promise<void> | undefined

  return {
    ...provider,
    getModels: () => mergeModels(provider.getModels(), dynamicModels),
    refreshModels: (context: RefreshModelsContext) => {
      inflight ??= (async () => {
        try {
          const stored = await context.store.read()
          if (stored) dynamicModels = toModels(provider.id, stored.models)
          if (!context.allowNetwork || context.signal?.aborted) return
          if (
            !context.force &&
            stored?.checkedAt !== undefined &&
            now() - stored.checkedAt < REFRESH_INTERVAL_MS
          ) {
            return
          }
          const timeout = AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS)
          const response = await fetcher(source.url, {
            headers: source.headers,
            signal: context.signal ? AbortSignal.any([context.signal, timeout]) : timeout
          })
          if (!response.ok) throw new Error(`${source.url} → ${response.status}`)
          const payload = await response.json()
          if (context.signal?.aborted) return
          const parsed = source.parse(payload)
          // A 200 with the wrong shape (e.g. a rate-limit error body, or a
          // differently-shaped model list) parses to zero entries same as an
          // actually-empty catalog, and the two are indistinguishable here.
          // Persisting either as {models: [], checkedAt: now} would pass the
          // freshness check on every restart within REFRESH_INTERVAL_MS, hiding
          // the provider for the whole window with no way back short of
          // `pi-route models refresh` — worse than the one extra GET per boot
          // (refreshModels runs at boot and on a 4 h interval, never per
          // request) that skipping the write costs a genuinely-empty provider.
          if (parsed.length === 0) {
            console.error(
              `[cached-catalog] "${provider.id}" returned a 200 with no parseable models; not persisting an empty catalog`
            )
            return
          }
          dynamicModels = parsed
          await context.store.write({ models: dynamicModels, checkedAt: now() })
        } catch (err) {
          console.error(`[cached-catalog] refresh failed for "${provider.id}": ${String(err)}`)
        } finally {
          inflight = undefined
        }
      })()
      return inflight
    }
  }
}

// Overlay a pi.dev-published dynamic catalog onto a static built-in provider.
// `upstreamId` is pi's provider id (e.g. "anthropic"); merged models carry the
// wrapped provider's (config) id so the rest of pi-route sees one namespace.
export const withRemoteCatalog = (
  provider: Provider,
  upstreamId: string,
  opts: RemoteCatalogOpts = {}
): Provider =>
  withCachedCatalog(
    provider,
    {
      url: new URL(
        `/api/models/providers/${encodeURIComponent(upstreamId)}`,
        opts.baseUrl ?? CATALOG_BASE_URL
      ).toString(),
      headers: { accept: 'application/json' },
      parse: (payload) => parseCatalog(provider.id, payload)
    },
    opts
  )

// Populate an openai-compatible provider's catalog from its own GET /models.
export const withEndpointCatalog = (
  provider: Provider,
  opts: EndpointCatalogOpts = {}
): Provider => {
  const baseUrl = provider.baseUrl ?? ''
  return withCachedCatalog(
    provider,
    {
      url: `${baseUrl}/models`,
      headers: {
        accept: 'application/json',
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {})
      },
      parse: (payload) =>
        [...parseOpenaiModelsList(payload)].map(([id, meta]) =>
          toModel(provider.id, baseUrl, id, meta)
        )
    },
    opts
  )
}
