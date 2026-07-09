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

const firstPlainTarget = (items: string[]): string | null => items.find(isPlain) ?? null

const roleModel = (
  options: RouterOptions,
  catalog: Catalog,
  role: 'default' | 'small'
): RoleModel | null => {
  const entry = options.pipeline.find(
    (p) => p.name === role && p.kind === 'pool' && p.match === 'exact'
  )
  if (!entry || entry.kind !== 'pool') return null
  const first = firstPlainTarget(entry.to)
  if (!first) return null
  // The role name is the pi-route address clients send; the leaf provides metadata.
  const leaf = catalog.leafFor.get(first) ?? first
  const resolved = resolveModel(options, catalog, leaf)
  const model = resolved.model
  return {
    id: role,
    name: model?.name ?? leaf,
    ...(model?.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model?.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    ...(model?.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
    ...(Array.isArray(model?.input) ? { input: model!.input } : {}),
    ...(model?.cost !== undefined ? { cost: model.cost } : {})
  }
}

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

// --- Setup engine writers ---

export type SetupEngine = 'claude' | 'codex' | 'qwen' | 'opencode' | 'omp' | 'pi' | 'openclaw'

const PI_ROUTE_URL = '${PI_ROUTE_URL:-http://127.0.0.1:3000}'
const PI_ROUTE_TOKEN = '${PI_ROUTE_TOKEN}'

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

const yamlString = (value: string): string => JSON.stringify(value)

const claudeWrites = async (
  home: string,
  def: RoleModel,
  small: RoleModel | null
): Promise<PlannedWrite[]> => [
  await plannedWrite(
    join(home, '.claude/settings.json'),
    json({
      model: 'sonnet',
      availableModels: small ? ['sonnet', 'haiku'] : ['sonnet'],
      env: {
        ANTHROPIC_BASE_URL: `${PI_ROUTE_URL}`,
        ANTHROPIC_AUTH_TOKEN: PI_ROUTE_TOKEN,
        ANTHROPIC_MODEL: 'sonnet',
        ANTHROPIC_DEFAULT_SONNET_MODEL: def.id,
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: def.name,
        ...(small
          ? {
              ANTHROPIC_DEFAULT_HAIKU_MODEL: small.id,
              ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: small.name
            }
          : {})
      }
    })
  )
]

const codexWrites = async (
  home: string,
  def: RoleModel,
  small: RoleModel | null
): Promise<PlannedWrite[]> => {
  const lines = [
    `model = ${JSON.stringify(def.id)}`,
    ...(small ? [`review_model = ${JSON.stringify(small.id)}`] : []),
    'model_provider = "piroute"',
    ...(def.contextWindow ? [`model_context_window = ${def.contextWindow}`] : []),
    ...(def.maxTokens ? [`model_max_output_tokens = ${def.maxTokens}`] : []),
    '',
    '[model_providers.piroute]',
    'name = "pi-route"',
    `base_url = "${PI_ROUTE_URL}/v1"`,
    'wire_api = "responses"',
    'env_key = "OPENAI_API_KEY"',
    'requires_openai_auth = false',
    ''
  ]
  return [await plannedWrite(join(home, '.codex/config.toml'), lines.join('\n'))]
}

const qwenModel = (m: RoleModel) => ({
  id: m.id,
  name: m.name,
  baseUrl: `${PI_ROUTE_URL}/v1`,
  envKey: 'OPENAI_API_KEY',
  ...(m.input?.includes('image') ? { capabilities: { vision: true } } : {}),
  ...(m.contextWindow ? { generationConfig: { contextWindowSize: m.contextWindow } } : {})
})

const qwenWrites = async (
  home: string,
  def: RoleModel,
  small: RoleModel | null
): Promise<PlannedWrite[]> => [
  await plannedWrite(
    join(home, '.qwen/settings.json'),
    json({
      security: { auth: { selectedType: 'openai', baseUrl: `${PI_ROUTE_URL}/v1` } },
      providerProtocol: { openai: 'openai' },
      modelProviders: { openai: [qwenModel(def), ...(small ? [qwenModel(small)] : [])] },
      model: { name: def.id }
    })
  )
]

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
  _options: RouterOptions,
  home: string,
  def: RoleModel,
  small: RoleModel | null
): Promise<PlannedWrite[]> => {
  const models = Object.fromEntries(
    [def, ...(small ? [small] : [])].map((m) => [m.id, modelDev(m)])
  )
  return [
    await plannedWrite(
      join(home, '.config/opencode/opencode.json'),
      json({
        model: `pi-route/${def.id}`,
        ...(small ? { small_model: `pi-route/${small.id}` } : {}),
        provider: {
          'pi-route': {
            npm: '@ai-sdk/openai-compatible',
            name: 'pi-route',
            id: 'pi-route',
            api: `${PI_ROUTE_URL}/v1`,
            env: ['OPENAI_API_KEY'],
            options: { baseURL: `${PI_ROUTE_URL}/v1` },
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
  home: string,
  def: RoleModel,
  small: RoleModel | null
): Promise<PlannedWrite[]> => {
  const overrides = [def, ...(small ? [small] : [])].flatMap((m) => overrideYaml(m, '      '))
  const modelsYml = [
    'providers:',
    '  piroute:',
    `    baseUrl: ${PI_ROUTE_URL}/v1`,
    `    apiKey: ${PI_ROUTE_TOKEN}`,
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
    `  default: ${yamlString(`piroute/${def.id}`)}`,
    ...(small ? [`  small: ${yamlString(`piroute/${small.id}`)}`] : []),
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
  home: string,
  def: RoleModel,
  small: RoleModel | null
): Promise<PlannedWrite[]> => [
  await plannedWrite(
    join(home, '.pi/agent/models.json'),
    json({
      providers: {
        piroute: {
          name: 'pi-route',
          baseUrl: `${PI_ROUTE_URL}/v1`,
          apiKey: PI_ROUTE_TOKEN,
          api: 'openai-completions',
          models: [],
          modelOverrides: Object.fromEntries(
            [def, ...(small ? [small] : [])].map((m) => [m.id, piOverride(m)])
          )
        }
      }
    })
  ),
  await plannedWrite(
    join(home, '.pi/agent/settings.json'),
    json({ defaultProvider: 'piroute', defaultModel: def.id })
  )
]

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
  home: string,
  def: RoleModel,
  small: RoleModel | null
): Promise<PlannedWrite[]> => [
  await plannedWrite(
    join(home, '.openclaw/openclaw.json'),
    json({
      models: {
        mode: 'merge',
        providers: {
          piroute: {
            baseUrl: `${PI_ROUTE_URL}/v1`,
            apiKey: PI_ROUTE_TOKEN,
            api: 'openai-completions',
            models: [openclawModel(def), ...(small ? [openclawModel(small)] : [])]
          }
        }
      },
      agents: {
        defaults: {
          model: { primary: `piroute/${def.id}` },
          models: { 'piroute/*': {} }
        }
      }
    })
  )
]

const buildSetupWrites = async (
  options: RouterOptions,
  engine: SetupEngine,
  home: string,
  def: RoleModel,
  small: RoleModel | null
): Promise<PlannedWrite[]> => {
  if (engine === 'claude') return claudeWrites(home, def, small)
  if (engine === 'codex') return codexWrites(home, def, small)
  if (engine === 'qwen') return qwenWrites(home, def, small)
  if (engine === 'opencode') return opencodeWrites(options, home, def, small)
  if (engine === 'omp') return ompWrites(home, def, small)
  if (engine === 'pi') return piWrites(home, def, small)
  return openclawWrites(home, def, small)
}

export const setupModels = async (
  options: RouterOptions,
  engine: SetupEngine,
  opts: { homeDir?: string; dry?: boolean }
): Promise<PlannedWrite[]> => {
  const home = opts.homeDir ?? homedir()
  const catalog = buildCatalog(options)
  const def = roleModel(options, catalog, 'default')
  if (!def) throw new Error('Missing pipeline.default exact-match role')
  const small = roleModel(options, catalog, 'small')
  const writes = await buildSetupWrites(options, engine, home, def, small)
  if (!opts.dry) await applyWrites(writes)
  return writes
}
