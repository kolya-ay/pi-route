import { getModel } from '@mariozechner/pi-ai'
import { Hono } from 'hono'
import type { Catalog } from '../pipeline/catalog'
import { exposeIncludes } from '../pipeline/match'
import type { RouterOptions } from '../types'

const perToken = (n: number | undefined): string | undefined => {
  if (n === undefined || Number.isNaN(n)) return undefined
  const s = (n / 1_000_000).toFixed(12)
  const trimmed = s.replace(/0+$/, '').replace(/\.$/, '')
  return trimmed || '0'
}

type ModelEntry = {
  id: string
  object: 'model'
  owned_by: string
  name?: string
  context_length?: number
  architecture?: { input_modalities: string[] }
  pricing?: { prompt?: string; completion?: string }
  top_provider?: { max_completion_tokens?: number }
  reasoning?: { supported_efforts?: string[] }
}

const buildEntry = (opts: RouterOptions, catalog: Catalog, address: string): ModelEntry => {
  const [ownedBy] = address.split('/')
  const owned_by = address.includes('/') ? (ownedBy ?? address) : address
  const leaf = catalog.leafFor.get(address) ?? address
  const slash = leaf.indexOf('/')
  const providerName = slash === -1 ? leaf : leaf.slice(0, slash)
  const modelId = slash === -1 ? '' : leaf.slice(slash + 1)
  const provider = opts.providers[providerName]
  const entry: ModelEntry = { id: address, object: 'model', owned_by }
  if (!provider || !modelId) return entry
  let m: ReturnType<typeof getModel> | null = null
  try {
    m = getModel(
      provider.type as Parameters<typeof getModel>[0],
      modelId as Parameters<typeof getModel>[1]
    )
  } catch {
    m = null
  }
  if (!m) return entry

  entry.name = m.name
  entry.context_length = m.contextWindow
  if (m.input && m.input.length > 0) {
    entry.architecture = { input_modalities: m.input }
  }
  const prompt = perToken(m.cost?.input)
  const completion = perToken(m.cost?.output)
  if (prompt !== undefined || completion !== undefined) {
    entry.pricing = {
      ...(prompt !== undefined ? { prompt } : {}),
      ...(completion !== undefined ? { completion } : {})
    }
  }
  if (m.maxTokens !== undefined) {
    entry.top_provider = { max_completion_tokens: m.maxTokens }
  }
  if (m.reasoning) {
    entry.reasoning = { supported_efforts: ['high', 'medium', 'low', 'minimal'] }
  }
  return entry
}

export const createModelsRoute = (options: RouterOptions, catalog: Catalog): Hono => {
  const app = new Hono()
  app.get('/', (c) => {
    const filtered: string[] = []
    for (const addr of catalog.addresses) {
      if (exposeIncludes(options.expose, addr)) filtered.push(addr)
    }
    filtered.sort()
    const data = filtered.map((addr) => buildEntry(options, catalog, addr))
    return c.json({ object: 'list', data })
  })
  return app
}
