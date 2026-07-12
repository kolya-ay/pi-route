// src/cli/models.ts

import { homedir } from 'node:os'

import { buildCatalog, type Catalog } from '../pipeline/catalog'
import { exposeIncludes } from '../pipeline/match'
import {
  displayName,
  exposedAddresses,
  type LiteLLMEntry,
  type ModelsDevModel,
  type OpenAIModelEntry,
  resolveModel,
  toLiteLLMInfo,
  toModelsDevModel,
  toOpenAIModel
} from '../routes/model-projection'
import type { RouterOptions } from '../types'
import { applyWrites, dedupById, type PlannedWrite, type RoleModel } from './agent'
import { AGENTS } from './agents'
import { unifiedDiff } from './diff'

export type ModelView = {
  id: string
  leaf: string
  owned_by: string
  openai: OpenAIModelEntry
  litellm: LiteLLMEntry | null
  modelsDev: ModelsDevModel | null
}

export const listModelIds = (options: RouterOptions): string[] =>
  exposedAddresses(options, buildCatalog(options))

export const showModel = (options: RouterOptions, id: string): ModelView => {
  const catalog: Catalog = buildCatalog(options)
  if (!exposeIncludes(options.expose, id) || !catalog.addresses.has(id)) {
    throw new Error(`Model not exposed: ${id}`)
  }
  const resolved = resolveModel(options, catalog, id)
  return {
    id,
    leaf: catalog.leafFor.get(id) ?? id,
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
  role: 'default' | 'smol'
): RoleModel[] => {
  const entry = options.pipeline.find((p) => p.name === role && p.kind === 'pool')
  if (entry?.kind !== 'pool') return []
  return entry.to.filter(isPlain).map((target) => {
    // The target (as written) is the real backend address the client sends;
    // the leaf provides metadata.
    const leaf = catalog.leafFor.get(target) ?? target
    const { provider, model } = resolveModel(options, catalog, leaf)
    // Prefix the bare name (not `leaf`, which already carries the provider) so the
    // metadata-miss fallback doesn't double it: `Cerebras/gpt-oss-120b`.
    const bare = model?.name ?? leaf.slice(leaf.indexOf('/') + 1)
    return {
      id: target,
      name: displayName(provider, bare),
      ...(model?.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model?.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
      ...(model?.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
      ...(Array.isArray(model?.input) ? { input: model!.input } : {}),
      ...(model?.cost !== undefined ? { cost: model.cost } : {})
    }
  })
}

// --- Planned writes ---

export const renderPlannedWrites = (writes: PlannedWrite[]): string =>
  writes.map((w) => `${w.action}  ${w.path}\n${unifiedDiff(w.before, w.content)}`).join('\n\n')

export const setupModels = async (
  options: RouterOptions,
  agentName: string,
  opts: { homeDir?: string; dry?: boolean; url: string }
): Promise<PlannedWrite[]> => {
  const agent = AGENTS.find((a) => a.name === agentName)
  if (!agent) throw new Error(`unknown agent: ${agentName}`)
  const home = opts.homeDir ?? homedir()
  const catalog = buildCatalog(options)
  const defaults = roleModels(options, catalog, 'default')
  if (defaults.length === 0) throw new Error('Missing pipeline.default exact-match role')
  const smols = roleModels(options, catalog, 'smol')
  const all = dedupById([...defaults, ...smols])
  const writes = await agent.write({
    url: opts.url,
    home,
    all,
    main: defaults[0]!,
    fast: smols[0] ?? null
  })
  if (!opts.dry) await applyWrites(writes)
  return writes
}
