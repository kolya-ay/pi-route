import type { Api, Model, Models } from '@earendil-works/pi-ai'
import { FETCH_TIMEOUT_MS } from '../models/fetch-timeout'
import type { DiscoverStrategy, ModelMetaOverride, RouterOptions } from '../types'
import type { Catalog, ModelMeta } from './catalog'

// pi-ai `Model` → our `ModelMeta`. Copies only the fields the projections use.
export const toModelMeta = (m: Model<Api>): ModelMeta => {
  const compat = m.compat as { supportsReasoningEffort?: boolean } | undefined
  return {
    name: m.name,
    // 0 means the endpoint didn't say (Model requires non-optional numbers, so
    // there is no `undefined` to fall back to) — normalize that sentinel to real
    // absence here, the one Model -> ModelMeta boundary, instead of leaving every
    // downstream reader to know the convention.
    ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
    ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
    ...(m.cost !== undefined
      ? {
          cost: {
            ...(m.cost.input !== undefined ? { input: m.cost.input } : {}),
            ...(m.cost.output !== undefined ? { output: m.cost.output } : {}),
            ...(m.cost.cacheRead !== undefined ? { cacheRead: m.cost.cacheRead } : {}),
            ...(m.cost.cacheWrite !== undefined ? { cacheWrite: m.cost.cacheWrite } : {})
          }
        }
      : {}),
    reasoning: Boolean(m.reasoning),
    ...(Array.isArray(m.input) ? { input: m.input } : {}),
    ...(m.thinkingLevelMap !== undefined
      ? { thinkingLevelMap: m.thinkingLevelMap as Record<string, string | null> }
      : {}),
    ...(compat?.supportsReasoningEffort !== undefined
      ? { supportsReasoningEffort: compat.supportsReasoningEffort }
      : {})
  }
}

// Deployment suffixes that don't change the base model's context/cost.
const QUANT_SUFFIXES = /-(tee|fp8|fp16|bf16|int8|int4|awq|gptq)$/i

// Lowercase, keep only the last path segment (drop org), strip quant/TEE suffixes,
// trim leftover separators. Version dots are preserved (m2.5 stays m2.5).
export const normalizeModelId = (id: string): string => {
  const leaf = id.slice(id.lastIndexOf('/') + 1).toLowerCase()
  let out = leaf
  let prev: string
  do {
    prev = out
    out = out.replace(QUANT_SUFFIXES, '')
  } while (out !== prev)
  return out.replace(/[-_]+$/, '')
}

// Built once per Models object: normalized model id -> ModelMeta, across the
// whole live catalog. Memoized by identity so a listing pass over many
// addresses rebuilds the index at most once.
const guessIndexCache = new WeakMap<Models, Map<string, ModelMeta>>()
const buildGuessIndex = (models: Models): Map<string, ModelMeta> => {
  const cached = guessIndexCache.get(models)
  if (cached) return cached
  const index = new Map<string, ModelMeta>()
  for (const m of models.getModels()) {
    // contextWindow 0 means an endpoint listed the id without describing it —
    // such an entry has nothing to lend, and would shadow one that does.
    if (!m.contextWindow) continue
    // guess lends limits/capabilities across DIFFERENT vendors that happen to
    // share a model id (e.g. nvidia's free-tier NIM and paid openrouter both
    // serving "moonshotai/kimi-k2.6"). Borrowing cost is a silent wrong answer
    // about money, not a visible absence — drop it here, before it enters the
    // index, so no guess hit can ever carry another vendor's price.
    const { cost: _cost, ...meta } = toModelMeta(m)
    const exact = m.id.slice(m.id.lastIndexOf('/') + 1).toLowerCase()
    if (!index.has(exact)) index.set(exact, meta)
    const norm = normalizeModelId(m.id)
    if (!index.has(norm)) index.set(norm, meta)
  }
  guessIndexCache.set(models, index)
  return index
}

// Match the address's leaf against the live catalog: exact leaf first, then normalized.
export const guessFromCatalog = (models: Models, address: string): ModelMeta | null => {
  const index = buildGuessIndex(models)
  const leaf = address.slice(address.lastIndexOf('/') + 1).toLowerCase()
  return index.get(leaf) ?? index.get(normalizeModelId(address)) ?? null
}

// Last-resort placeholder metadata (mirrors the codex writer's `?? 200000`).
export const fallbackMeta = (name: string): ModelMeta => ({
  name,
  contextWindow: 200000,
  cost: { input: 0, output: 0 },
  reasoning: false
})

// Field-wise patch of an override over a base. Returns null only when both are empty.
export const applyOverride = (
  base: ModelMeta | null,
  override: ModelMetaOverride | undefined
): ModelMeta | null => {
  if (!override || !Object.values(override).some((v) => v !== undefined)) return base
  const start: ModelMeta = base ?? { name: override.name ?? '' }
  return {
    ...start,
    ...(override.name !== undefined ? { name: override.name } : {}),
    ...(override.contextWindow !== undefined ? { contextWindow: override.contextWindow } : {}),
    ...(override.maxTokens !== undefined ? { maxTokens: override.maxTokens } : {}),
    ...(override.cost !== undefined
      ? {
          cost: {
            ...start.cost,
            ...(override.cost.input !== undefined ? { input: override.cost.input } : {}),
            ...(override.cost.output !== undefined ? { output: override.cost.output } : {}),
            ...(override.cost.cacheRead !== undefined
              ? { cacheRead: override.cost.cacheRead }
              : {}),
            ...(override.cost.cacheWrite !== undefined
              ? { cacheWrite: override.cost.cacheWrite }
              : {})
          }
        }
      : {}),
    ...(override.reasoning !== undefined ? { reasoning: override.reasoning } : {}),
    ...(override.input !== undefined ? { input: override.input } : {})
  }
}

// 'auto' expands to [openai-models-list, guess]; 'openai' is an alias for openai-models-list.
const expandAuto = (chain: DiscoverStrategy[]): DiscoverStrategy[] =>
  chain.flatMap((s) =>
    s === 'auto'
      ? (['openai-models-list', 'guess'] as DiscoverStrategy[])
      : s === 'openai'
        ? (['openai-models-list'] as DiscoverStrategy[])
        : [s]
  )

type RawEntry = Record<string, unknown>
const num = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}
const dataArray = (payload: unknown): RawEntry[] => {
  const data = (payload as { data?: unknown })?.data
  return Array.isArray(data) ? (data as RawEntry[]) : []
}

// chutes/OpenRouter/vLLM style: GET /models with extra context/pricing fields.
export const parseOpenaiModelsList = (payload: unknown): Map<string, ModelMeta> => {
  const out = new Map<string, ModelMeta>()
  for (const e of dataArray(payload)) {
    const id = typeof e.id === 'string' ? e.id : undefined
    if (!id) continue
    const pricing = (e.pricing ?? {}) as RawEntry
    const contextWindow = num(e.context_length) ?? num(e.max_model_len)
    const maxTokens = num(e.max_output_length)
    const input = num(pricing.prompt)
    const output = num(pricing.completion)
    const mods = Array.isArray(e.input_modalities) ? (e.input_modalities as string[]) : undefined
    const meta: ModelMeta = {
      name: typeof e.name === 'string' ? e.name : id,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(input !== undefined || output !== undefined
        ? {
            cost: {
              ...(input !== undefined ? { input } : {}),
              ...(output !== undefined ? { output } : {})
            }
          }
        : {}),
      ...(mods ? { input: mods } : {})
    }
    out.set(id, meta)
  }
  return out
}

// litellm proxy style: GET /model/info with model_info blocks (per-token cost → per-million).
export const parseLitellmModelInfo = (payload: unknown): Map<string, ModelMeta> => {
  const out = new Map<string, ModelMeta>()
  for (const e of dataArray(payload)) {
    const name = typeof e.model_name === 'string' ? e.model_name : undefined
    const info = (e.model_info ?? {}) as RawEntry
    if (!name) continue
    const contextWindow = num(info.max_input_tokens)
    const maxTokens = num(info.max_output_tokens)
    const inPer = num(info.input_cost_per_token)
    const outPer = num(info.output_cost_per_token)
    const meta: ModelMeta = {
      name,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(inPer !== undefined || outPer !== undefined
        ? {
            cost: {
              ...(inPer !== undefined ? { input: inPer * 1e6 } : {}),
              ...(outPer !== undefined ? { output: outPer * 1e6 } : {})
            }
          }
        : {}),
      ...(info.supports_reasoning !== undefined
        ? { reasoning: Boolean(info.supports_reasoning) }
        : {})
    }
    out.set(name, meta)
  }
  return out
}

const httpGetJson = async (
  url: string,
  key: string | undefined,
  timeoutMs: number
): Promise<unknown> => {
  const res = await globalThis.fetch(url, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!res.ok) throw new Error(`${url} → ${res.status}`)
  return res.json()
}

// Fetch one provider's live metadata via whichever live method its discover chain names.
// Returns modelId -> ModelMeta (unprefixed). Never throws; failure → empty map.
export const fetchProviderMetadata = async (
  name: string,
  provider: import('../types').ProviderConfig,
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<Map<string, ModelMeta>> => {
  const liveStrat = expandAuto(provider.discover || []).find(
    (s) => s === 'openai-models-list' || s === 'litellm'
  )
  if (!liveStrat || !provider.baseUrl) return new Map()
  const key = provider.account.credential === 'key' ? provider.account.key : undefined
  try {
    return liveStrat === 'openai-models-list'
      ? parseOpenaiModelsList(await httpGetJson(`${provider.baseUrl}/models`, key, timeoutMs))
      : parseLitellmModelInfo(await httpGetJson(`${provider.baseUrl}/model/info`, key, timeoutMs))
  } catch (err) {
    console.error(`[metadata] live fetch failed for provider "${name}": ${String(err)}`)
    return new Map()
  }
}

// Populate catalog.liveMeta (address-keyed) for every discover-enabled provider.
export const enrichLiveMeta = async (opts: RouterOptions, catalog: Catalog): Promise<void> => {
  const entries = Object.entries(opts.providers)
  await Promise.all(
    entries.map(async ([name, provider]) => {
      const map = await fetchProviderMetadata(name, provider)
      for (const [modelId, meta] of map) catalog.liveMeta.set(`${name}/${modelId}`, meta)
    })
  )
}

const splitLeaf = (leaf: string): { providerName: string; modelId: string } => {
  const slash = leaf.indexOf('/')
  return slash === -1
    ? { providerName: leaf, modelId: '' }
    : { providerName: leaf.slice(0, slash), modelId: leaf.slice(slash + 1) }
}

// Resolve one exposed address to metadata: Models baseline → discover chain → override patch.
export const resolveMetadata = (
  opts: RouterOptions,
  catalog: Catalog,
  models: Models,
  address: string
): ModelMeta | null => {
  const leaf = catalog.leafFor.get(address) ?? address
  const { providerName, modelId } = splitLeaf(leaf)
  const provider = opts.providers[providerName]

  // Layer 0: Models static/dynamic catalog (authoritative for known providers).
  // A contextWindow of 0 means the provider's endpoint listed the id without
  // describing it — not authoritative, so the discover chain still runs.
  let base: ModelMeta | null = null
  if (provider && modelId) {
    const m = models.getModel(providerName, modelId)
    base = m?.contextWindow ? toModelMeta(m) : null
  }

  // Layer 1: the provider's discover chain — first hit wins.
  if (!base && provider?.discover) {
    for (const strat of expandAuto(provider.discover)) {
      if (strat === 'openai-models-list' || strat === 'litellm') {
        // Same convention as layer 0: a live entry with no contextWindow means
        // the endpoint listed the id without describing it, so it can't win here.
        const live = catalog.liveMeta.get(leaf)
        base = live?.contextWindow ? live : null
      } else if (strat === 'guess') {
        base = guessFromCatalog(models, leaf)
      } else if (strat === 'fallback') {
        base = fallbackMeta(modelId || address)
      }
      if (base) break
    }
  }

  // Layer 2: per-model override patch (keyed by the backend leaf model id).
  return applyOverride(base, provider?.modelOverrides?.[modelId])
}
