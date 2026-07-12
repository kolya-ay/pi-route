// src/cli/models.ts

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
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

const plannedWrite = async (path: string, content: string): Promise<PlannedWrite> => ({
  path,
  action: existsSync(path) ? 'update' : 'create',
  content
})

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

export type Harness = 'claude' | 'codex' | 'qwen' | 'opencode' | 'omp' | 'pi' | 'openclaw'

// The pi-route base URL, resolved from env at install time. Clients don't
// uniformly expand shell vars, so we bake the concrete URL. The token is a
// secret and stays in the PI_ROUTE_API_KEY / ANTHROPIC_AUTH_TOKEN env var — never
// written to a config file.
const PI_ROUTE_API_KEY = 'PI_ROUTE_API_KEY'

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

const yamlString = (value: string): string => JSON.stringify(value)

const claudeWrites = async (
  url: string,
  home: string,
  defaults: RoleModel[],
  smols: RoleModel[]
): Promise<PlannedWrite[]> => {
  const all = dedupById([...defaults, ...smols])
  const main = defaults[0]!
  const fast = smols[0] ?? null
  return [
    await plannedWrite(
      join(home, '.claude/settings.json'),
      json({
        model: main.id,
        availableModels: all.map((m) => m.id),
        env: {
          // Token stays in the ambient ANTHROPIC_AUTH_TOKEN env var, not baked here.
          ANTHROPIC_BASE_URL: url,
          ANTHROPIC_MODEL: main.id,
          // Fast/background slot (titles, summaries). ANTHROPIC_SMALL_FAST_MODEL is
          // deprecated in favor of ANTHROPIC_DEFAULT_HAIKU_MODEL.
          ...(fast ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: fast.id } : {})
        }
      })
    )
  ]
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
  const lines = [
    `model = ${JSON.stringify(main.id)}`,
    'model_provider = "piroute"',
    `model_catalog_json = ${JSON.stringify(catalogFile)}`,
    ...(main.contextWindow ? [`model_context_window = ${main.contextWindow}`] : []),
    ...(main.maxTokens ? [`model_max_output_tokens = ${main.maxTokens}`] : []),
    '',
    '[model_providers.piroute]',
    'name = "pi-route"',
    `base_url = ${JSON.stringify(`${url}/v1`)}`,
    'wire_api = "responses"',
    `env_key = ${JSON.stringify(PI_ROUTE_API_KEY)}`,
    'requires_openai_auth = false',
    ''
  ]
  return [
    await plannedWrite(join(home, '.codex/config.toml'), lines.join('\n')),
    // codex parses this file as ModelsResponse = { models: ModelInfo[] } — a bare
    // array fails with "invalid type: map, expected a sequence".
    await plannedWrite(catalogPath, json({ models: all.map(codexCatalogEntry) }))
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
  return [
    await plannedWrite(
      join(home, '.qwen/settings.json'),
      json({
        security: { auth: { selectedType: 'openai', baseUrl: `${url}/v1` } },
        providerProtocol: { openai: 'openai' },
        modelProviders: { openai: all.map((m) => qwenModel(m, url)) },
        model: { name: main.id }
      })
    )
  ]
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
  _options: RouterOptions,
  home: string,
  defaults: RoleModel[],
  smols: RoleModel[]
): Promise<PlannedWrite[]> => {
  const all = dedupById([...defaults, ...smols])
  const main = defaults[0]!
  const fast = smols[0] ?? null
  const models = Object.fromEntries(all.map((m) => [m.id, modelDev(m)]))
  return [
    await plannedWrite(
      join(home, '.config/opencode/opencode.json'),
      json({
        model: `pi-route/${main.id}`,
        ...(fast ? { small_model: `pi-route/${fast.id}` } : {}),
        provider: {
          'pi-route': {
            npm: '@ai-sdk/openai-compatible',
            name: 'pi-route',
            id: 'pi-route',
            api: `${url}/v1`,
            env: [PI_ROUTE_API_KEY],
            options: { baseURL: `${url}/v1` },
            models
          }
        }
      })
    )
  ]
}

const costYaml = (m: RoleModel, indent: string): string[] => {
  const lines: string[] = []
  if (m.cost?.input !== undefined || m.cost?.output !== undefined) {
    lines.push(`${indent}cost:`)
    if (m.cost.input !== undefined) lines.push(`${indent}  input: ${m.cost.input}`)
    if (m.cost.output !== undefined) lines.push(`${indent}  output: ${m.cost.output}`)
  }
  return lines
}

const overrideYaml = (m: RoleModel, indent: string): string[] => [
  `${indent}${yamlString(m.id)}:`,
  `${indent}  name: ${yamlString(m.name)}`,
  ...(m.contextWindow ? [`${indent}  contextWindow: ${m.contextWindow}`] : []),
  ...(m.maxTokens ? [`${indent}  maxTokens: ${m.maxTokens}`] : []),
  ...costYaml(m, `${indent}  `)
]

const ompWrites = async (
  url: string,
  home: string,
  defaults: RoleModel[],
  smols: RoleModel[]
): Promise<PlannedWrite[]> => {
  const all = dedupById([...defaults, ...smols])
  const main = defaults[0]!
  const fast = smols[0] ?? null
  const overrides = all.flatMap((m) => overrideYaml(m, '      '))
  const modelsYml = [
    'providers:',
    '  piroute:',
    `    baseUrl: ${yamlString(`${url}/v1`)}`,
    // omp reads apiKey as an env-var name (or literal fallback); keep the token in env.
    `    apiKey: ${PI_ROUTE_API_KEY}`,
    '    api: openai-completions',
    '    auth: apiKey',
    '    discovery:',
    '      type: litellm',
    '    modelOverrides:',
    ...overrides,
    ''
  ].join('\n')
  const configYml = [
    'modelRoles:',
    `  default: ${yamlString(`piroute/${main.id}`)}`,
    ...(fast ? [`  smol: ${yamlString(`piroute/${fast.id}`)}`] : []),
    ''
  ].join('\n')
  return [
    await plannedWrite(join(home, '.omp/agent/models.yml'), modelsYml),
    await plannedWrite(join(home, '.omp/agent/config.yml'), configYml)
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
    await plannedWrite(
      join(home, '.pi/agent/models.json'),
      json({
        providers: {
          piroute: {
            name: 'pi-route',
            baseUrl: `${url}/v1`,
            // pi expands ${VAR} in apiKey; keep the token in env.
            apiKey: `\${${PI_ROUTE_API_KEY}}`,
            api: 'openai-completions',
            models: [],
            modelOverrides: Object.fromEntries(all.map((m) => [m.id, piOverride(m)]))
          }
        }
      })
    ),
    await plannedWrite(
      join(home, '.pi/agent/settings.json'),
      json({ defaultProvider: 'piroute', defaultModel: main.id })
    )
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
  return [
    await plannedWrite(
      join(home, '.openclaw/openclaw.json'),
      json({
        models: {
          mode: 'merge',
          providers: {
            piroute: {
              baseUrl: `${url}/v1`,
              // openclaw expands ${VAR} in apiKey; keep the token in env.
              apiKey: `\${${PI_ROUTE_API_KEY}}`,
              api: 'openai-completions',
              models: all.map(openclawModel)
            }
          }
        },
        agents: {
          defaults: {
            model: { primary: `piroute/${main.id}` },
            models: { 'piroute/*': {} }
          }
        }
      })
    )
  ]
}

const buildSetupWrites = async (
  options: RouterOptions,
  harness: Harness,
  url: string,
  home: string,
  defaults: RoleModel[],
  smols: RoleModel[]
): Promise<PlannedWrite[]> => {
  if (harness === 'claude') return claudeWrites(url, home, defaults, smols)
  if (harness === 'codex') return codexWrites(url, home, defaults, smols)
  if (harness === 'qwen') return qwenWrites(url, home, defaults, smols)
  if (harness === 'opencode') return opencodeWrites(url, options, home, defaults, smols)
  if (harness === 'omp') return ompWrites(url, home, defaults, smols)
  if (harness === 'pi') return piWrites(url, home, defaults, smols)
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
  const writes = await buildSetupWrites(options, harness, opts.url, home, defaults, smols)
  if (!opts.dry) await applyWrites(writes)
  return writes
}
