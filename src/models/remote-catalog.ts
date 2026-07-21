import type { Api, Model, Provider, RefreshModelsContext } from '@earendil-works/pi-ai'

const CATALOG_BASE_URL = 'https://pi.dev'
export const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

export type RemoteCatalogOpts = {
  now?: () => number
  fetcher?: Fetcher
  baseUrl?: string
}

export const mergeModels = (
  baseline: readonly Model<Api>[],
  dynamic: readonly Model<Api>[]
): Model<Api>[] => {
  const byId = new Map(baseline.map((m) => [m.id, m]))
  for (const model of dynamic) byId.set(model.id, model)
  return [...byId.values()]
}

const parseCatalog = (configId: string, value: unknown): Model<Api>[] => {
  const raw = (value as { models?: unknown })?.models
  const entries = Array.isArray(value) ? value : Array.isArray(raw) ? raw : []
  return entries
    .filter((e): e is Model<Api> => typeof e === 'object' && e !== null && 'id' in e)
    .map((m) => ({ ...m, provider: configId }))
}

// Overlay a pi.dev-published dynamic catalog onto a static built-in provider.
// `upstreamId` is pi's provider id (e.g. "anthropic"); merged models carry the
// wrapped provider's (config) id so the rest of pi-route sees one namespace.
export const withRemoteCatalog = (
  provider: Provider,
  upstreamId: string,
  opts: RemoteCatalogOpts = {}
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
          if (stored) dynamicModels = parseCatalog(provider.id, stored.models)
          if (!context.allowNetwork || context.signal?.aborted) return
          if (
            !context.force &&
            stored?.checkedAt !== undefined &&
            now() - stored.checkedAt < REFRESH_INTERVAL_MS
          ) {
            return
          }
          const url = new URL(
            `/api/models/providers/${encodeURIComponent(upstreamId)}`,
            opts.baseUrl ?? CATALOG_BASE_URL
          )
          const response = await fetcher(url.toString(), {
            headers: { accept: 'application/json' },
            ...(context.signal ? { signal: context.signal } : {})
          })
          if (!response.ok) throw new Error(`pi.dev catalog → ${response.status}`)
          dynamicModels = parseCatalog(provider.id, await response.json())
          await context.store.write({ models: dynamicModels, checkedAt: now() })
        } catch (err) {
          console.error(`[remote-catalog] refresh failed for "${provider.id}": ${String(err)}`)
        } finally {
          inflight = undefined
        }
      })()
      return inflight
    }
  }
}
