import type { Models } from '@earendil-works/pi-ai'

import { availableProviders } from '../config/availability'
import type { RouterOptions } from '../types'
import { hasGlobMetachars } from './match'

// Our own metadata subset — the union of fields the projection functions read.
// Every metadata source (pi-ai, live fetch, guess, fallback, override) produces this,
// so nothing downstream depends on pi-ai's full Model type.
export type ModelMeta = {
  name: string
  contextWindow?: number
  maxTokens?: number
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  reasoning?: boolean
  input?: string[]
  thinkingLevelMap?: Record<string, string | null>
  supportsReasoningEffort?: boolean
}

export type Catalog = {
  addresses: Set<string>
  leafFor: Map<string, string>
  liveMeta: Map<string, ModelMeta> // address -> live-fetched metadata (empty until enriched)
  // Providers that could serve a request when this catalog was built. The
  // dispatch gate reads it instead of stat()-ing a credential file per hop, so
  // it goes stale between rebuilds exactly as the addresses do.
  available: Set<string>
}

// `liveMeta` is required: the catalog wrapper has been writing each provider's
// lossless parse into the caller's map, and this catalog reads that work. A
// forgotten map would show every unstated price as $0.00 rather than unknown —
// so the caller must pass one explicitly, even if empty.
export const buildCatalog = (
  opts: RouterOptions,
  models: Models,
  authDir: string,
  liveMeta: Map<string, ModelMeta>
): Catalog => {
  const addresses = new Set<string>()
  const leafFor = new Map<string, string>()

  const available = availableProviders(opts, authDir)
  const entryByName = new Map(opts.pipeline.map((e) => [e.name, e]))

  // A target is usable when its head segment is an available provider, or when
  // it names a pipeline entry that itself reaches one. An unknown head (a
  // provider that was never configured, e.g. a commented-out `ag`) is not
  // routable, so it is dropped. `seen` breaks reference cycles: a cycle reaches
  // no provider, so nothing on it is usable.
  const usable = (item: string, seen: ReadonlySet<string> = new Set()): boolean => {
    const slash = item.indexOf('/')
    const head = slash === -1 ? item : item.slice(0, slash)
    if (head in opts.providers) return available.has(head)
    const entry = entryByName.get(head)
    if (!entry || seen.has(head)) return false
    const next = new Set(seen).add(head)
    return entry.kind === 'alias'
      ? usable(entry.target, next)
      : entry.to.some((t) => usable(t, next))
  }

  // 1. Provider leaf addresses from the Models collection (keyed by config name)
  for (const name of Object.keys(opts.providers)) {
    if (!available.has(name)) continue
    for (const m of models.getModels(name)) {
      const addr = `${name}/${m.id}`
      addresses.add(addr)
      leafFor.set(addr, addr)
    }
  }

  // Snapshot leaf set before adding derived addresses (so pool prefixes
  // don't recursively expand off each other).
  const leafAddresses = [...addresses]

  // 2. Literal pipeline targets (no glob metachars, no unresolved captures)
  for (const entry of opts.pipeline) {
    const items = entry.kind === 'alias' ? [entry.target] : entry.to
    for (const item of items) {
      if (hasGlobMetachars(item) || item.includes('$')) continue
      if (!usable(item)) continue
      addresses.add(item)
      leafFor.set(item, item)
    }
  }

  // 3. Alias names, exact-pool names, and pool-prefix addresses
  for (const entry of opts.pipeline) {
    if (entry.kind === 'alias') {
      if (!usable(entry.target)) continue
      addresses.add(entry.name)
      leafFor.set(entry.name, leafFor.get(entry.target) ?? entry.target)
      continue
    }
    if (entry.match === 'exact') {
      const firstTarget = entry.to.find((t) => usable(t))
      if (!firstTarget) continue
      addresses.add(entry.name)
      leafFor.set(entry.name, leafFor.get(firstTarget) ?? firstTarget)
      continue
    }
    // For pool entries: expose <entry.name>/<tail> for each `<provider>/$1`-style item
    for (const item of entry.to) {
      // Only handle templates of the form '<prefix>/$1' (tail propagation).
      const m = /^([^*?[]+)\/\$1$/.exec(item)
      if (!m) continue
      const prefix = m[1]
      if (!prefix || !usable(`${prefix}/x`)) continue
      for (const leaf of leafAddresses) {
        if (leaf.startsWith(`${prefix}/`)) {
          const tail = leaf.slice(prefix.length + 1)
          const poolAddr = `${entry.name}/${tail}`
          addresses.add(poolAddr)
          leafFor.set(poolAddr, leaf)
        }
      }
    }
  }

  return { addresses, leafFor, liveMeta, available }
}
