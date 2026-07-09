import type { BalancingStrategyName, PipelineEntry, RouterOptions } from '../types'
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
    if (!entry.match) return { fired: true, captures: [] }
  }
  if (entry.kind === 'alias') {
    return model === entry.name ? { fired: true, captures: [] } : { fired: false }
  }
  if (entry.match === 'exact') {
    return model === entry.name ? { fired: true, captures: [] } : { fired: false }
  }
  // pool, default prefix semantics: match key/**
  const caps = matches(`${entry.name}/**`, model)
  if (caps !== null) return { fired: true, captures: caps }
  return { fired: false }
}

const pickStrategy = (
  strategy: Exclude<BalancingStrategyName, 'failover'>,
  candidates: string[],
  counter: { i: number }
): string => {
  if (candidates.length === 0) throw new Error('no candidates')
  const first = candidates[0]
  if (!first) throw new Error('no candidates')
  if (strategy === 'sticky' || strategy === 'fill-first') return first
  // round-robin
  const v = candidates[counter.i % candidates.length]
  if (!v) throw new Error('no candidates')
  counter.i += 1
  return v
}

const enumerateCatalog = (catalog: Catalog, pattern: string): string[] => {
  const re = compileGlob(pattern).regex
  const out: string[] = []
  for (const a of catalog.addresses) if (re.test(a)) out.push(a)
  return out
}

const splitAddress = (opts: RouterOptions, address: string): ResolveResult => {
  const slash = address.indexOf('/')
  if (slash === -1) throw new Error(`unresolved bare model "${address}" — no provider prefix`)
  const provider = address.slice(0, slash)
  const modelId = address.slice(slash + 1)
  if (!opts.providers[provider]) {
    throw new Error(`unknown provider "${provider}" in resolved model "${address}"`)
  }
  return { provider, modelId }
}

export const resolveCandidates = (
  opts: RouterOptions,
  catalog: Catalog,
  initialModel: string,
  req: ResolveRequest
): ResolveResult[] => {
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
    // Failover pools surface the full ordered candidate list; everything else
    // (alias, round-robin, sticky, fill-first) reduces to a single pick that
    // may itself fire another pipeline entry on the next iteration.
    if (firedEntry.kind === 'pool' && firedEntry.strategy === 'failover') {
      return candidates.map((address) => splitAddress(opts, address))
    }

    if (candidates.length === 0) continue

    const strategy: Exclude<BalancingStrategyName, 'failover'> =
      firedEntry.kind === 'pool' && firedEntry.strategy !== 'failover'
        ? firedEntry.strategy
        : 'round-robin'
    const newModel = pickStrategy(strategy, candidates, counter)
    if (newModel === model) break
    model = newModel
  }

  const slash = model.indexOf('/')
  if (slash === -1) {
    if (seen.size > 0) {
      throw new Error(`pipeline cycle detected; entries fired: ${[...seen].join(', ')}`)
    }
    throw new Error(`unresolved bare model "${model}" — no provider prefix`)
  }
  return [splitAddress(opts, model)]
}
