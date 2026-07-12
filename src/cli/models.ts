// src/cli/models.ts

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { buildCatalog, type Catalog } from '../pipeline/catalog'
import { exposeIncludes } from '../pipeline/match'
import {
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
import { type Edit, patchJson, patchToml, patchYaml } from './config-patch'

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

export type RoleModel = {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  input?: string[]
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
}

const isPlain = (item: string): boolean =>
  !item.includes('*') && !item.includes('?') && !item.includes('[') && !item.includes('$')

const roleModels = (
  options: RouterOptions,
  catalog: Catalog,
  role: 'default' | 'smol'
): RoleModel[] => {
  const entry = options.pipeline.find(
    (p) => p.name === role && p.kind === 'pool' && p.match === 'exact'
  )
  if (!entry || entry.kind !== 'pool') return []
  return entry.to.filter(isPlain).map((target) => {
    // The target (as written) is the real backend address the client sends;
    // the leaf provides metadata.
    const leaf = catalog.leafFor.get(target) ?? target
    const model = resolveModel(options, catalog, leaf).model
    return {
      id: target,
      name: model?.name ?? leaf,
      ...(model?.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model?.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
      ...(model?.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
      ...(Array.isArray(model?.input) ? { input: model!.input } : {}),
      ...(model?.cost !== undefined ? { cost: model.cost } : {})
    }
  })
}

const dedupById = (models: RoleModel[]): RoleModel[] => [
  ...new Map(models.map((m) => [m.id, m])).values()
]

// --- Planned writes ---

export type PlannedWrite = {
  path: string
  action: 'create' | 'update'
  content: string
}

// Read the user's existing file (or start empty), merge pi-route's key-paths,
// return the full merged text. Absent file -> action 'create'.
const mergedWrite = async (
  path: string,
  patch: (existing: string, edits: Edit[]) => string,
  edits: Edit[]
): Promise<PlannedWrite> => {
  const present = existsSync(path)
  const existing = present ? await readFile(path, 'utf8') : ''
  return { path, action: present ? 'update' : 'create', content: patch(existing, edits) }
}

const applyWrites = async (writes: PlannedWrite[]): Promise<void> => {
  await Promise.all(
    writes.map(async (w) => {
      await mkdir(dirname(w.path), { recursive: true })
      await writeFile(w.path, w.content)
    })
  )
}

export const renderPlannedWrites = (writes: PlannedWrite[]): string =>
  writes
    .map((w) => {
      const header = `${w.action}  ${w.path}`
      const body = w.content
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n')
      return `${header}\n${body}`
    })
    .join('\n\n')

// --- Setup harness writers ---

export type Harness = 'claude' | 'codex' | 'qwen' | 'opencode' | 'omp' | 'pi' | 'openclaw' | 'zed'

// The pi-route base URL, resolved from env at install time. Clients don't
// uniformly expand shell vars, so we bake the concrete URL. The token is a
// secret and stays in the PI_ROUTE_API_KEY / ANTHROPIC_AUTH_TOKEN env var — never
// written to a config file.
const PI_ROUTE_API_KEY = 'PI_ROUTE_API_KEY'

const edit = (path: (string | number)[], value: unknown): Edit => [path, value]

const claudeWrites = async (
  url: string,
  home: string,
  defaults: RoleModel[],
  smols: RoleModel[]
): Promise<PlannedWrite[]> => {
  const all = dedupById([...defaults, ...smols])
  const main = defaults[0]!
  const fast = smols[0] ?? null
  // Token stays in the ambient ANTHROPIC_AUTH_TOKEN env var, not baked here.
  // Fast/background slot (titles, summaries) uses ANTHROPIC_DEFAULT_HAIKU_MODEL;
  // ANTHROPIC_SMALL_FAST_MODEL is deprecated.
  const edits: Edit[] = [
    edit(['model'], main.id),
    edit(
      ['availableModels'],
      all.map((m) => m.id)
    ),
    edit(['env', 'ANTHROPIC_BASE_URL'], url),
    edit(['env', 'ANTHROPIC_MODEL'], main.id),
    ...(fast ? [edit(['env', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'], fast.id)] : [])
  ]
  return [await mergedWrite(join(home, '.claude/settings.json'), patchJson, edits)]
}

// Codex resolves request model ids by longest-prefix against a bundled catalog.
// A custom-provider id (real backend address) matches nothing -> "metadata not
// found" warning. A static model_catalog_json whose slug == the id silences it.
// Required fields track codex-rs/protocol/src/openai_models.rs on `main`; if
// codex errors at startup parsing this file, upstream added a field — add it here.
const codexCatalogEntry = (m: RoleModel) => ({
  slug: m.id,
  display_name: m.name,
  supported_reasoning_levels: [] as string[],
  shell_type: 'shell_command',
  visibility: 'list',
  supported_in_api: true,
  priority: 1,
  base_instructions: '',
  supports_reasoning_summaries: false,
  default_reasoning_summary: 'none',
  support_verbosity: false,
  truncation_policy: { mode: 'tokens', limit: 10000 }, // codex default truncation window
  supports_parallel_tool_calls: true,
  experimental_supported_tools: [] as string[],
  context_window: m.contextWindow ?? 200000, // codex fallback when pi-route has no metadata
  max_context_window: m.contextWindow ?? 200000
})

const codexWrites = async (
  url: string,
  home: string,
  defaults: RoleModel[],
  smols: RoleModel[]
): Promise<PlannedWrite[]> => {
  const all = dedupById([...defaults, ...smols])
  const main = defaults[0]!
  // codex resolves a relative model_catalog_json against ~/.codex/ (its config
  // dir), not cwd — so the bare basename points at the file we write beside it.
  const catalogFile = 'pi-route-catalog.json'
  const catalogPath = join(home, '.codex', catalogFile)
  const edits: Edit[] = [
    edit(['model'], main.id),
    edit(['model_provider'], 'piroute'),
    edit(['model_catalog_json'], catalogFile),
    ...(main.contextWindow ? [edit(['model_context_window'], main.contextWindow)] : []),
    ...(main.maxTokens ? [edit(['model_max_output_tokens'], main.maxTokens)] : []),
    edit(['model_providers', 'piroute'], {
      name: 'pi-route',
      base_url: `${url}/v1`,
      wire_api: 'responses',
      env_key: PI_ROUTE_API_KEY,
      requires_openai_auth: false
    })
  ]
  // pi-route-owned catalog file: overwrite (not a merge). codex parses it as { models: ModelInfo[] }.
  const catalogContent = `${JSON.stringify({ models: all.map(codexCatalogEntry) }, null, 2)}\n`
  return [
    await mergedWrite(join(home, '.codex/config.toml'), patchToml, edits),
    {
      path: catalogPath,
      action: existsSync(catalogPath) ? 'update' : 'create',
      content: catalogContent
    }
  ]
}

const qwenModel = (m: RoleModel, url: string) => ({
  id: m.id,
  name: m.name,
  baseUrl: `${url}/v1`,
  envKey: PI_ROUTE_API_KEY,
  ...(m.input?.includes('image') ? { capabilities: { vision: true } } : {}),
  ...(m.contextWindow ? { generationConfig: { contextWindowSize: m.contextWindow } } : {})
})

const qwenWrites = async (
  url: string,
  home: string,
  defaults: RoleModel[],
  smols: RoleModel[]
): Promise<PlannedWrite[]> => {
  const all = dedupById([...defaults, ...smols])
  const main = defaults[0]!
  const edits: Edit[] = [
    edit(['security', 'auth'], { selectedType: 'openai', baseUrl: `${url}/v1` }),
    edit(['providerProtocol', 'openai'], 'openai'),
    edit(
      ['modelProviders', 'openai'],
      all.map((m) => qwenModel(m, url))
    ),
    edit(['model', 'name'], main.id)
  ]
  return [await mergedWrite(join(home, '.qwen/settings.json'), patchJson, edits)]
}

const modelDev = (m: RoleModel): ModelsDevModel => ({
  id: m.id,
  name: m.name,
  attachment: Boolean(m.input?.includes('image')),
  reasoning: Boolean(m.reasoning),
  tool_call: true,
  temperature: true,
  modalities: { input: m.input && m.input.length > 0 ? m.input : ['text'], output: ['text'] },
  limit: {
    ...(m.contextWindow ? { context: m.contextWindow } : {}),
    ...(m.maxTokens ? { output: m.maxTokens } : {})
  },
  cost: {
    ...(m.cost?.input !== undefined ? { input: m.cost.input } : {}),
    ...(m.cost?.output !== undefined ? { output: m.cost.output } : {}),
    ...(m.cost?.cacheRead !== undefined ? { cache_read: m.cost.cacheRead } : {}),
    ...(m.cost?.cacheWrite !== undefined ? { cache_write: m.cost.cacheWrite } : {})
  }
})

const opencodeWrites = async (
  url: string,
  home: string,
  defaults: RoleModel[],
  smols: RoleModel[]
): Promise<PlannedWrite[]> => {
  const all = dedupById([...defaults, ...smols])
  const main = defaults[0]!
  const fast = smols[0] ?? null
  const models = Object.fromEntries(all.map((m) => [m.id, modelDev(m)]))
  const edits: Edit[] = [
    edit(['model'], `pi-route/${main.id}`),
    ...(fast ? [edit(['small_model'], `pi-route/${fast.id}`)] : []),
    edit(['provider', 'pi-route'], {
      npm: '@ai-sdk/openai-compatible',
      name: 'pi-route',
      id: 'pi-route',
      api: `${url}/v1`,
      env: [PI_ROUTE_API_KEY],
      options: { baseURL: `${url}/v1` },
      models
    })
  ]
  return [await mergedWrite(join(home, '.config/opencode/opencode.json'), patchJson, edits)]
}

const ompModelOverride = (m: RoleModel) => ({
  name: m.name,
  ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
  ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
  ...(m.cost?.input !== undefined || m.cost?.output !== undefined
    ? {
        cost: {
          ...(m.cost.input !== undefined ? { input: m.cost.input } : {}),
          ...(m.cost.output !== undefined ? { output: m.cost.output } : {})
        }
      }
    : {})
})

const ompWrites = async (
  url: string,
  home: string,
  defaults: RoleModel[],
  smols: RoleModel[]
): Promise<PlannedWrite[]> => {
  const all = dedupById([...defaults, ...smols])
  const main = defaults[0]!
  const fast = smols[0] ?? null
  return [
    await mergedWrite(join(home, '.omp/agent/models.yml'), patchYaml, [
      edit(['providers', 'piroute'], {
        baseUrl: `${url}/v1`,
        // omp reads apiKey as an env-var name (or literal fallback); keep the token in env.
        apiKey: PI_ROUTE_API_KEY,
        api: 'openai-completions',
        auth: 'apiKey',
        discovery: { type: 'litellm' },
        modelOverrides: Object.fromEntries(all.map((m) => [m.id, ompModelOverride(m)]))
      })
    ]),
    await mergedWrite(join(home, '.omp/agent/config.yml'), patchYaml, [
      edit(['modelRoles', 'default'], `piroute/${main.id}`),
      ...(fast ? [edit(['modelRoles', 'smol'], `piroute/${fast.id}`)] : [])
    ])
  ]
}

const piOverride = (m: RoleModel) => ({
  name: m.name,
  ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
  ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
  ...(m.cost
    ? {
        cost: {
          ...(m.cost.input !== undefined ? { input: m.cost.input } : {}),
          ...(m.cost.output !== undefined ? { output: m.cost.output } : {})
        }
      }
    : {})
})

const piWrites = async (
  url: string,
  home: string,
  defaults: RoleModel[],
  smols: RoleModel[]
): Promise<PlannedWrite[]> => {
  const all = dedupById([...defaults, ...smols])
  const main = defaults[0]!
  return [
    await mergedWrite(join(home, '.pi/agent/models.json'), patchJson, [
      edit(['providers', 'piroute'], {
        name: 'pi-route',
        baseUrl: `${url}/v1`,
        apiKey: `\${${PI_ROUTE_API_KEY}}`,
        api: 'openai-completions',
        models: [],
        modelOverrides: Object.fromEntries(all.map((m) => [m.id, piOverride(m)]))
      })
    ]),
    await mergedWrite(join(home, '.pi/agent/settings.json'), patchJson, [
      edit(['defaultProvider'], 'piroute'),
      edit(['defaultModel'], main.id)
    ])
  ]
}

const openclawModel = (m: RoleModel) => ({
  id: m.id,
  name: m.name,
  ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
  input: m.input && m.input.length > 0 ? m.input : ['text'],
  ...(m.cost
    ? {
        cost: {
          input: m.cost.input ?? 0,
          output: m.cost.output ?? 0,
          cacheRead: m.cost.cacheRead ?? 0,
          cacheWrite: m.cost.cacheWrite ?? 0
        }
      }
    : {}),
  ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
  ...(m.maxTokens ? { maxTokens: m.maxTokens } : {})
})

const openclawWrites = async (
  url: string,
  home: string,
  defaults: RoleModel[],
  smols: RoleModel[]
): Promise<PlannedWrite[]> => {
  const all = dedupById([...defaults, ...smols])
  const main = defaults[0]!
  const edits: Edit[] = [
    edit(['models', 'mode'], 'merge'),
    edit(['models', 'providers', 'piroute'], {
      baseUrl: `${url}/v1`,
      apiKey: `\${${PI_ROUTE_API_KEY}}`,
      api: 'openai-completions',
      models: all.map(openclawModel)
    }),
    edit(['agents', 'defaults', 'model', 'primary'], `piroute/${main.id}`),
    edit(['agents', 'defaults', 'models', 'piroute/*'], {})
  ]
  return [await mergedWrite(join(home, '.openclaw/openclaw.json'), patchJson, edits)]
}

// Zed reads the model catalog + all metadata ONLY from settings.json ->
// available_models (it never calls /v1/models for an openai_compatible provider).
// Verified against zed main: reasoning_effort is open_ai::ReasoningEffort (lowercase
// minimal|low|medium|high|xhigh|max|none), "medium" valid; ModelCapabilities uses serde
// defaults so a { tools, images } subset is accepted; the openai_compatible settings
// sub-key is the provider id used in agent.default_model.provider ("pi-route"); the edit-
// prediction provider literal is "open_ai_compatible_api" (edit_predictions sub-key), fields
// api_url/model/max_output_tokens(64)/prompt_format:"infer".
const openaiCompatibleModel = (m: RoleModel) => ({
  name: m.id,
  display_name: m.name,
  // Zed "max_tokens" == context window
  ...(m.contextWindow ? { max_tokens: m.contextWindow } : {}),
  ...(m.maxTokens ? { max_output_tokens: m.maxTokens } : {}),
  capabilities: { tools: true, images: m.input?.includes('image') ?? false },
  ...(m.reasoning ? { reasoning_effort: 'medium' } : {})
})

const zedWrites = async (
  url: string,
  home: string,
  defaults: RoleModel[],
  smols: RoleModel[]
): Promise<PlannedWrite[]> => {
  const all = dedupById([...defaults, ...smols])
  const main = defaults[0]!
  const fast = smols[0] ?? null
  const edits: Edit[] = [
    edit(['language_models', 'openai_compatible', 'pi-route'], {
      api_url: `${url}/v1`,
      available_models: all.map(openaiCompatibleModel)
    }),
    edit(['agent', 'default_model'], {
      provider: 'pi-route',
      model: main.id,
      enable_thinking: Boolean(main.reasoning)
    }),
    ...(fast
      ? [
          edit(['edit_predictions', 'open_ai_compatible_api'], {
            api_url: `${url}/v1`,
            model: fast.id,
            max_output_tokens: fast.maxTokens ?? 64,
            prompt_format: 'infer'
          }),
          edit(['features', 'edit_prediction_provider'], 'open_ai_compatible_api')
        ]
      : [])
  ]
  return [await mergedWrite(join(home, '.config/zed/settings.json'), patchJson, edits)]
}

const buildSetupWrites = async (
  harness: Harness,
  url: string,
  home: string,
  defaults: RoleModel[],
  smols: RoleModel[]
): Promise<PlannedWrite[]> => {
  if (harness === 'claude') return claudeWrites(url, home, defaults, smols)
  if (harness === 'codex') return codexWrites(url, home, defaults, smols)
  if (harness === 'qwen') return qwenWrites(url, home, defaults, smols)
  if (harness === 'opencode') return opencodeWrites(url, home, defaults, smols)
  if (harness === 'omp') return ompWrites(url, home, defaults, smols)
  if (harness === 'pi') return piWrites(url, home, defaults, smols)
  if (harness === 'zed') return zedWrites(url, home, defaults, smols)
  return openclawWrites(url, home, defaults, smols)
}

export const setupModels = async (
  options: RouterOptions,
  harness: Harness,
  opts: { homeDir?: string; dry?: boolean; url: string }
): Promise<PlannedWrite[]> => {
  const home = opts.homeDir ?? homedir()
  const catalog = buildCatalog(options)
  const defaults = roleModels(options, catalog, 'default')
  if (defaults.length === 0) throw new Error('Missing pipeline.default exact-match role')
  const smols = roleModels(options, catalog, 'smol')
  const writes = await buildSetupWrites(harness, opts.url, home, defaults, smols)
  if (!opts.dry) await applyWrites(writes)
  return writes
}
