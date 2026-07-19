import type { Models } from '@earendil-works/pi-ai'
import type { Catalog, ModelMeta } from '../pipeline/catalog'
import { exposeIncludes } from '../pipeline/match'
import { resolveMetadata } from '../pipeline/metadata'
import type { RouterOptions } from '../types'

// Display + filter order for reasoning effort levels (high→minimal), matching
// the legacy /v1/models output.
// Note: pi-ai ThinkingLevel also has 'xhigh'; intentionally excluded to match legacy output.
const EFFORTS = ['high', 'medium', 'low', 'minimal'] as const

export type Resolved = { id: string; owned_by: string; provider: string; model: ModelMeta | null }

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

// Provider-prefixed display name, e.g. "Nvidia/Kimi K2.6".
export const displayName = (provider: string, name: string): string =>
  `${capitalize(provider)}/${name}`

// address → provider/leaf → Model. Never throws; unknown → { model: null }.
export const resolveModel = (
  opts: RouterOptions,
  catalog: Catalog,
  models: Models,
  address: string
): Resolved => {
  const [ownedBy] = address.split('/')
  const owned_by = address.includes('/') ? (ownedBy ?? address) : address
  // Backend provider = first segment of the resolved leaf, so aliases/pools prefix
  // with the real provider (alias `solo` → `Cerebras/…`, not `Solo/…`).
  const leaf = catalog.leafFor.get(address) ?? address
  const provider = leaf.includes('/') ? leaf.slice(0, leaf.indexOf('/')) : owned_by
  return { id: address, owned_by, provider, model: resolveMetadata(opts, catalog, models, address) }
}

// Sorted list of addresses passing the expose allowlist. Shared by all three
// metadata endpoints so they expose exactly the same model set.
export const exposedAddresses = (options: RouterOptions, catalog: Catalog): string[] => {
  const filtered: string[] = []
  for (const addr of catalog.addresses) {
    if (exposeIncludes(options.expose, addr)) filtered.push(addr)
  }
  filtered.sort()
  return filtered
}

export type Capabilities = {
  vision: boolean
  reasoning: boolean
  tools: boolean
  temperature: boolean
  efforts: string[]
  reasoningEffortParam: boolean
}

// Hybrid derivation: real signals from ModelMeta; assume-true only for
// tools/temperature (no pi-ai field represents them).
export const capabilities = (m: ModelMeta): Capabilities => {
  const vision = Array.isArray(m.input) && m.input.includes('image')
  const reasoning = Boolean(m.reasoning)
  const map = m.thinkingLevelMap
  const efforts = !reasoning
    ? []
    : map
      ? EFFORTS.filter((e) => map[e] !== null && map[e] !== undefined)
      : [...EFFORTS]
  const reasoningEffortParam = reasoning && m.supportsReasoningEffort !== false
  return { vision, reasoning, tools: true, temperature: true, efforts, reasoningEffortParam }
}

// Input modalities with a safe default (some catalog entries omit `input`).
const inputModalities = (m: ModelMeta): string[] =>
  Array.isArray(m.input) && m.input.length > 0 ? m.input : ['text']

// pi-ai cost is USD per MILLION tokens. A: per-token string.
export const perTokenString = (perMillion: number | undefined): string | undefined => {
  if (perMillion === undefined || Number.isNaN(perMillion)) return undefined
  const s = (perMillion / 1_000_000).toFixed(12)
  const trimmed = s.replace(/0+$/, '').replace(/\.$/, '')
  return trimmed || '0'
}

const perTokenNumber = (perMillion: number | undefined): number | undefined =>
  perMillion === undefined || Number.isNaN(perMillion) ? undefined : perMillion / 1_000_000

export type OpenAIModelEntry = {
  id: string
  object: 'model'
  created: 0
  owned_by: string
  name?: string
  context_length?: number
  context_window?: number
  max_model_len?: number
  max_tokens?: number
  top_provider?: { max_completion_tokens?: number }
  type?: 'language'
  pricing?: { prompt?: string; completion?: string; input?: string; output?: string }
  architecture?: { input_modalities: string[]; output_modalities: string[] }
  supported_parameters?: string[]
  reasoning?: { supported_efforts: string[] }
}

export const toOpenAIModel = (r: Resolved): OpenAIModelEntry => {
  const base: OpenAIModelEntry = { id: r.id, object: 'model', created: 0, owned_by: r.owned_by }
  const m = r.model
  // Endpoint A lists unknown/unresolvable models as bare entries; B and C omit them.
  if (!m) return base
  const cap = capabilities(m)
  const entry: OpenAIModelEntry = {
    ...base,
    name: displayName(r.provider, m.name),
    type: 'language'
  }
  if (m.contextWindow !== undefined) {
    entry.context_length = m.contextWindow
    entry.context_window = m.contextWindow
    entry.max_model_len = m.contextWindow
  }
  if (m.maxTokens !== undefined) {
    entry.max_tokens = m.maxTokens
    entry.top_provider = { max_completion_tokens: m.maxTokens }
  }
  const prompt = perTokenString(m.cost?.input)
  const completion = perTokenString(m.cost?.output)
  if (prompt !== undefined || completion !== undefined) {
    entry.pricing = {
      ...(prompt !== undefined ? { prompt, input: prompt } : {}),
      ...(completion !== undefined ? { completion, output: completion } : {})
    }
  }
  const inputMods = inputModalities(m)
  entry.architecture = { input_modalities: inputMods, output_modalities: ['text'] }
  const params = ['tools', 'temperature', 'max_tokens']
  if (cap.reasoningEffortParam) params.push('reasoning')
  entry.supported_parameters = params
  if (cap.reasoning) entry.reasoning = { supported_efforts: cap.efforts }
  return entry
}

export type LiteLLMEntry = {
  model_name: string
  litellm_params: { model: string }
  model_info: {
    key: string
    litellm_provider: 'openai'
    mode: 'chat'
    supports_vision: boolean
    supports_reasoning: boolean
    supports_function_calling: boolean
    max_input_tokens?: number
    max_output_tokens?: number
    input_cost_per_token?: number
    output_cost_per_token?: number
    supported_openai_params: string[]
  }
}

export const toLiteLLMInfo = (r: Resolved): LiteLLMEntry | null => {
  const m = r.model
  if (!m) return null
  const cap = capabilities(m)
  const params = ['tools', 'tool_choice', 'temperature']
  if (cap.reasoningEffortParam) params.push('reasoning_effort')
  const info: LiteLLMEntry['model_info'] = {
    key: r.id,
    litellm_provider: 'openai',
    mode: 'chat',
    supports_vision: cap.vision,
    supports_reasoning: cap.reasoning,
    supports_function_calling: cap.tools,
    supported_openai_params: params
  }
  if (m.contextWindow !== undefined) info.max_input_tokens = m.contextWindow
  if (m.maxTokens !== undefined) info.max_output_tokens = m.maxTokens
  const input = perTokenNumber(m.cost?.input)
  const output = perTokenNumber(m.cost?.output)
  if (input !== undefined) info.input_cost_per_token = input
  if (output !== undefined) info.output_cost_per_token = output
  return { model_name: r.id, litellm_params: { model: r.id }, model_info: info }
}

export type ModelsDevModel = {
  id: string
  name: string
  attachment: boolean
  reasoning: boolean
  tool_call: boolean
  temperature: boolean
  modalities: { input: string[]; output: string[] }
  limit: { context?: number; output?: number }
  cost: { input?: number; output?: number; cache_read?: number; cache_write?: number }
}

// models.dev unit is USD per MILLION — same as pi-ai — so cost copies verbatim.
export const toModelsDevModel = (r: Resolved): ModelsDevModel | null => {
  const m = r.model
  if (!m) return null
  const cap = capabilities(m)
  const inputMods = inputModalities(m)
  return {
    id: r.id,
    name: displayName(r.provider, m.name),
    attachment: cap.vision,
    reasoning: cap.reasoning,
    tool_call: cap.tools,
    temperature: cap.temperature,
    modalities: { input: inputMods, output: ['text'] },
    limit: {
      ...(m.contextWindow !== undefined ? { context: m.contextWindow } : {}),
      ...(m.maxTokens !== undefined ? { output: m.maxTokens } : {})
    },
    cost: {
      ...(m.cost?.input !== undefined ? { input: m.cost.input } : {}),
      ...(m.cost?.output !== undefined ? { output: m.cost.output } : {}),
      ...(m.cost?.cacheRead !== undefined ? { cache_read: m.cost.cacheRead } : {}),
      ...(m.cost?.cacheWrite !== undefined ? { cache_write: m.cost.cacheWrite } : {})
    }
  }
}
