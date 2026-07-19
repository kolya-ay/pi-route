// src/cli/models.ts

import { homedir } from 'node:os'
import type { Models } from '@earendil-works/pi-ai'

import { buildCatalog, type Catalog, type ModelMeta } from '../pipeline/catalog'
import { exposeIncludes } from '../pipeline/match'
import {
  capabilities,
  displayName,
  exposedAddresses,
  type LiteLLMEntry,
  type ModelsDevModel,
  type OpenAIModelEntry,
  type Resolved,
  resolveModel,
  toLiteLLMInfo,
  toModelsDevModel,
  toOpenAIModel
} from '../routes/model-projection'
import type { RouterOptions } from '../types'
import { applyWrites, dedupById, type PlannedWrite, type RoleModel } from './agent'
import { AGENTS } from './agents'
import { unifiedDiff } from './diff'
import {
  bold,
  type Colorize,
  colorizeDiff,
  costPair,
  cyan,
  dim,
  EM_DASH,
  green,
  humanCost,
  humanCount,
  renderTable
} from './format'

export type ModelView = {
  id: string
  leaf: string
  owned_by: string
  openai: OpenAIModelEntry
  litellm: LiteLLMEntry | null
  modelsDev: ModelsDevModel | null
}

export type Tier = 'full' | 'partial' | 'stub'

// Grounded in ModelMeta: "full" means the routing-critical fields (context,
// max output, and at least one cost side) all resolved. null model => id-only stub.
export const completeness = (m: ModelMeta | null): Tier => {
  if (!m) return 'stub'
  const hasCost = m.cost?.input !== undefined || m.cost?.output !== undefined
  return m.contextWindow !== undefined && m.maxTokens !== undefined && hasCost ? 'full' : 'partial'
}

const tierPaint = (t: Tier): ((s: string) => string) =>
  t === 'full' ? green : t === 'stub' ? dim : (s: string) => s

const withCommas = (n: number): string => n.toLocaleString('en-US')

const inputMods = (m: ModelMeta): string[] =>
  Array.isArray(m.input) && m.input.length > 0 ? m.input : ['text']

// Resolve an exposed address to its model + backend leaf, or throw if it isn't exposed.
const resolveExposed = (
  options: RouterOptions,
  models: Models,
  id: string
): { resolved: Resolved; leaf: string } => {
  const catalog: Catalog = buildCatalog(options, models)
  if (!exposeIncludes(options.expose, id) || !catalog.addresses.has(id)) {
    throw new Error(`Model not exposed: ${id}`)
  }
  return {
    resolved: resolveModel(options, catalog, models, id),
    leaf: catalog.leafFor.get(id) ?? id
  }
}

// Human-readable detail block for `models show`. Mirrors showModel's resolution
// but renders instead of projecting to JSON.
export const renderModelDetail = (options: RouterOptions, models: Models, id: string): string => {
  const { resolved, leaf } = resolveExposed(options, models, id)
  const m = resolved.model
  const tier = completeness(m)
  const name = m ? displayName(resolved.provider, m.name) : id
  const head = `${bold(id)}   ${name}      ${tierPaint(tier)(tier)}`
  if (!m) return `${head}\n  ${dim('no metadata resolved (id only)')}`
  const cap = capabilities(m)
  const fields: [string, string][] = [
    ['provider', leaf === id ? resolved.provider : `${resolved.provider}   (leaf ${leaf})`],
    ['context', m.contextWindow !== undefined ? `${withCommas(m.contextWindow)} tokens` : EM_DASH],
    ['max out', m.maxTokens !== undefined ? `${withCommas(m.maxTokens)} tokens` : EM_DASH],
    ['price', `${humanCost(m.cost?.input, m.cost?.output)}   per 1M tokens`],
    ['modality', `${inputMods(m).join(', ')} → text`]
  ]
  if (cap.reasoning) fields.push(['reasoning', cap.efforts.join(' · ') || '(yes)'])
  const caps = [
    'tools',
    'temperature',
    ...(cap.reasoning ? ['reasoning'] : []),
    ...(cap.vision ? ['vision'] : [])
  ]
  fields.push(['caps', caps.join(' · ')])
  const body = fields.map(([k, v]) => `  ${dim(k.padEnd(9))} ${v}`).join('\n')
  return `${head}\n${body}`
}

export type ModelRow = {
  id: string
  ctx: string
  max: string
  cost: string
  caps: string
  tier: Tier
}

// One display row per exposed address, with completeness tier + compact cells.
export const modelRows = (options: RouterOptions, models: Models): ModelRow[] => {
  const catalog = buildCatalog(options, models)
  return exposedAddresses(options, catalog).map((id) => {
    const { model } = resolveModel(options, catalog, models, id)
    const cap = model ? capabilities(model) : null
    const flags = cap
      ? [cap.reasoning ? 'reason' : '', cap.vision ? 'vision' : ''].filter(Boolean)
      : []
    return {
      id,
      ctx: humanCount(model?.contextWindow),
      max: humanCount(model?.maxTokens),
      cost: costPair(model?.cost?.input, model?.cost?.output),
      caps: flags.length > 0 ? flags.join(' ') : '·',
      tier: completeness(model)
    }
  })
}

// Non-TTY -> today's exact machine output (plain ids). TTY -> aligned table with
// the model id tinted by completeness tier and a dim legend.
export const renderModelList = (rows: ModelRow[], tty: boolean): string => {
  if (!tty) return rows.map((r) => r.id).join('\n')
  if (rows.length === 0) return ''
  const headers = ['MODEL', 'CTX', 'MAX', '$ IN/OUT', 'CAPS']
  const body = rows.map((r) => [r.id, r.ctx, r.max, r.cost, r.caps])
  const colorize: Colorize = (ri, ci, cell) => {
    if (ci !== 0) return cell
    return tierPaint(rows[ri]?.tier ?? 'partial')(cell)
  }
  return `${renderTable(headers, body, colorize)}\n\n${dim('full · partial · stub')}`
}

export const showModel = (options: RouterOptions, models: Models, id: string): ModelView => {
  const { resolved, leaf } = resolveExposed(options, models, id)
  return {
    id,
    leaf,
    owned_by: resolved.owned_by,
    openai: toOpenAIModel(resolved),
    litellm: toLiteLLMInfo(resolved),
    modelsDev: toModelsDevModel(resolved)
  }
}

// --- Role resolution ---

const isPlain = (item: string): boolean =>
  !item.includes('*') && !item.includes('?') && !item.includes('[') && !item.includes('$')

const roleModels = (
  options: RouterOptions,
  catalog: Catalog,
  models: Models,
  role: 'default' | 'fast'
): RoleModel[] => {
  const entry = options.pipeline.find((p) => p.name === role && p.kind === 'pool')
  if (entry?.kind !== 'pool') return []
  return entry.to.filter(isPlain).map((target) => {
    // The target (as written) is the real backend address the client sends;
    // the leaf provides metadata.
    const leaf = catalog.leafFor.get(target) ?? target
    const { provider, model } = resolveModel(options, catalog, models, leaf)
    // Prefix the bare name (not `leaf`, which already carries the provider) so the
    // metadata-miss fallback doesn't double it: `Cerebras/gpt-oss-120b`.
    const bare = model?.name ?? leaf.slice(leaf.indexOf('/') + 1)
    const input = model?.input
    return {
      id: target,
      name: displayName(provider, bare),
      ...(model?.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model?.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
      ...(model?.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
      ...(Array.isArray(input) ? { input } : {}),
      ...(model?.cost !== undefined ? { cost: model.cost } : {})
    }
  })
}

// --- Planned writes ---

export const renderPlannedWrites = (writes: PlannedWrite[]): string =>
  writes
    .map(
      (w) => `${cyan(`${w.action}  ${w.path}`)}\n${colorizeDiff(unifiedDiff(w.before, w.content))}`
    )
    .join('\n\n')

export const setupModels = async (
  options: RouterOptions,
  models: Models,
  agentName: string,
  opts: { homeDir?: string; dry?: boolean; url: string }
): Promise<PlannedWrite[]> => {
  const agent = AGENTS.find((a) => a.name === agentName)
  if (!agent) throw new Error(`unknown agent: ${agentName}`)
  const home = opts.homeDir ?? homedir()
  const catalog = buildCatalog(options, models)
  const defaults = roleModels(options, catalog, models, 'default')
  const main = defaults[0]
  if (!main) throw new Error('Missing pipeline.default exact-match role')
  const fasts = roleModels(options, catalog, models, 'fast')
  const all = dedupById([...defaults, ...fasts])
  const writes = await agent.write({
    url: opts.url,
    home,
    all,
    main,
    fast: fasts[0] ?? null
  })
  if (!opts.dry) await applyWrites(writes)
  return writes
}
