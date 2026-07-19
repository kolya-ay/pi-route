import type { Models } from '@earendil-works/pi-ai'

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
}

export const buildCatalog = (opts: RouterOptions, models: Models): Catalog => {
  const addresses = new Set<string>()
  const leafFor = new Map<string, string>()
  const liveMeta = new Map<string, ModelMeta>()

  // 1. Provider leaf addresses from the Models collection (keyed by config name)
  for (const name of Object.keys(opts.providers)) {
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
      if (!hasGlobMetachars(item) && !item.includes('$')) {
        addresses.add(item)
        leafFor.set(item, item)
      }
    }
  }

  // 3. Alias names, exact-pool names, and pool-prefix addresses
  for (const entry of opts.pipeline) {
    if (entry.kind === 'alias') {
      addresses.add(entry.name)
      leafFor.set(entry.name, leafFor.get(entry.target) ?? entry.target)
      continue
    }
    if (entry.match === 'exact') {
      addresses.add(entry.name)
      const firstTarget = entry.to[0]
      if (firstTarget) leafFor.set(entry.name, leafFor.get(firstTarget) ?? firstTarget)
      continue
    }
    // For pool entries: expose <entry.name>/<tail> for each `<provider>/$1`-style item
    for (const item of entry.to) {
      // Only handle templates of the form '<prefix>/$1' (tail propagation).
      const m = /^([^*?[]+)\/\$1$/.exec(item)
      if (!m) continue
      const prefix = m[1]
      if (!prefix) continue
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

  return { addresses, leafFor, liveMeta }
}
