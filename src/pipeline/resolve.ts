import type { PipelineEntry, RouterOptions } from '../types'
import type { Catalog } from './catalog'
import { compileGlob, hasGlobMetachars, matches, substitute } from './match'

export type ResolveResult = {
  provider: string
  modelId: string
}

export type ResolveRequest = { thinking?: boolean }

const MAX_ITERATIONS = 16

type FireResult = { fired: false } | { fired: true; captures: string[] }

const fires = (entry: PipelineEntry, model: string, req: ResolveRequest): FireResult => {
  if (entry.kind === 'pool' && entry.when) {
    if (entry.when.thinking !== undefined && req.thinking !== entry.when.thinking) {
      return { fired: false }
    }
    return { fired: true, captures: [] }
  }
  if (entry.kind === 'alias') {
    return model === entry.name ? { fired: true, captures: [] } : { fired: false }
  }
  // pool, no `when`: match key/**
  const caps = matches(`${entry.name}/**`, model)
  if (caps !== null) return { fired: true, captures: caps }
  return { fired: false }
}

const pickStrategy = (
  strategy: 'round-robin' | 'sticky' | 'fill-first',
  candidates: string[],
  counter: { i: number }
): string => {
  if (candidates.length === 0) throw new Error('no candidates')
  if (strategy === 'sticky' || strategy === 'fill-first') return candidates[0]!
  // round-robin
  const v = candidates[counter.i % candidates.length]!
  counter.i += 1
  return v
}

const enumerateCatalog = (catalog: Catalog, pattern: string): string[] => {
  const re = compileGlob(pattern).regex
  const out: string[] = []
  for (const a of catalog.addresses) if (re.test(a)) out.push(a)
  return out
}

export const resolveModel = (
  opts: RouterOptions,
  catalog: Catalog,
  initialModel: string,
  req: ResolveRequest
): ResolveResult => {
  let model = initialModel
  const seen = new Set<string>()
  const counter = { i: 0 }

  for (let iter = 0; iter < MAX_ITERATIONS; iter += 1) {
    let firedEntry: PipelineEntry | null = null
    let captures: string[] = []
    for (const entry of opts.pipeline) {
      if (seen.has(entry.name)) continue
      const r = fires(entry, model, req)
      if (r.fired) {
        firedEntry = entry
        captures = r.captures
        break
      }
    }
    if (!firedEntry) break
    seen.add(firedEntry.name)

    const items = firedEntry.kind === 'alias' ? [firedEntry.target] : firedEntry.to
    const candidates: string[] = []
    for (const item of items) {
      const substituted = substitute(item, captures, model)
      if (hasGlobMetachars(substituted)) candidates.push(...enumerateCatalog(catalog, substituted))
      else candidates.push(substituted)
    }
    if (candidates.length === 0) continue
    const strategy = firedEntry.kind === 'pool' ? firedEntry.strategy : 'round-robin'
    const newModel = pickStrategy(strategy, candidates, counter)
    if (newModel === model) break
    model = newModel
  }

  const slash = model.indexOf('/')
  if (slash === -1) {
    // If we have a `seen` set with any entries, the bare model is the residue of
    // a cycle (entries flipped a→b→a until both were `seen`, then nothing fired).
    if (seen.size > 0) {
      throw new Error(`pipeline cycle detected; entries fired: ${[...seen].join(', ')}`)
    }
    throw new Error(`unresolved bare model "${model}" — no provider prefix`)
  }
  const provider = model.slice(0, slash)
  const modelId = model.slice(slash + 1)
  if (!opts.providers[provider]) {
    throw new Error(`unknown provider "${provider}" in resolved model "${model}"`)
  }
  return { provider, modelId }
}
