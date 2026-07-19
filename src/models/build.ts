import { join } from 'node:path'
import type { MutableModels, Provider } from '@earendil-works/pi-ai'
import { createModels, createProvider, envApiKeyAuth } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { cerebrasProvider } from '@earendil-works/pi-ai/providers/cerebras'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'
import { fileCredentialStore } from '../auth/credential-store'
import { antigravityProvider } from '../providers/antigravity-provider'
import type { ProviderConfig, RouterOptions } from '../types'
import { withRemoteCatalog } from './remote-catalog'
import { fileModelsStore } from './store'

export type BuildDirs = { stateDir: string; authDir: string }

const FACTORIES: Partial<Record<string, () => Provider>> = {
  anthropic: anthropicProvider as () => Provider,
  'openai-codex': openaiCodexProvider as () => Provider,
  cerebras: cerebrasProvider as () => Provider,
  openrouter: openrouterProvider as () => Provider
}

// Same provider under a config-chosen id: models and credentials keyed by the
// config name so two accounts of one type never collide.
const reident = (provider: Provider, id: string): Provider => ({
  ...provider,
  id,
  name: id,
  getModels: () => provider.getModels().map((m) => ({ ...m, provider: id }))
})

const buildOne = (name: string, config: ProviderConfig): Provider | undefined => {
  if (config.type === 'antigravity') return antigravityProvider(name)
  const factory = FACTORIES[config.type]
  if (factory) return reident(factory(), name)
  if (config.type === 'openai-compatible' || config.type === 'openai') {
    if (!config.baseUrl) throw new Error(`provider "${name}" requires baseUrl`)
    return createProvider({
      id: name,
      name,
      baseUrl: config.baseUrl,
      auth: { apiKey: envApiKeyAuth(`${name} API key`, []) },
      models: [],
      api: openAICompletionsApi()
    })
  }
  return undefined // passthrough and unknown types stay outside Models
}

export const buildModels = (options: RouterOptions, dirs: BuildDirs): MutableModels => {
  const models = createModels({
    credentials: fileCredentialStore(dirs.authDir, options),
    modelsStore: fileModelsStore(join(dirs.stateDir, 'models'))
  })
  for (const [name, config] of Object.entries(options.providers)) {
    const built = buildOne(name, config)
    if (!built) continue
    const upstream = FACTORIES[config.type] ? config.type : undefined
    const wrapped =
      upstream && config.discover !== false ? withRemoteCatalog(built, upstream) : built
    models.setProvider(wrapped)
  }
  return models
}
