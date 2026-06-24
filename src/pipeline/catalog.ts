import { getModels } from '@mariozechner/pi-ai'

import type { RouterOptions } from '../types'
import { hasGlobMetachars } from './match'

export type Catalog = {
  addresses: Set<string>
  leafFor: Map<string, string>
}

const safeGetModels = (type: string): { id: string }[] => {
  try {
    return getModels(type as Parameters<typeof getModels>[0]) as { id: string }[]
  } catch {
    return []
  }
}

export const buildCatalog = (opts: RouterOptions): Catalog => {
  const addresses = new Set<string>()
  const leafFor = new Map<string, string>()

  // 1. Provider leaf addresses from pi-ai
  for (const [name, p] of Object.entries(opts.providers)) {
    for (const m of safeGetModels(p.type)) {
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

  // 3. Alias names + pool-prefix addresses
  for (const entry of opts.pipeline) {
    if (entry.kind === 'alias') {
      addresses.add(entry.name)
      leafFor.set(entry.name, leafFor.get(entry.target) ?? entry.target)
      continue
    }
    // For pool entries: expose <entry.name>/<tail> for each `<provider>/$1`-style item
    for (const item of entry.to) {
      // Only handle templates of the form '<prefix>/$1' (tail propagation).
      const m = /^([^*?[]+)\/\$1$/.exec(item)
      if (!m) continue
      const prefix = m[1]!
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

  return { addresses, leafFor }
}
