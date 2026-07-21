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
import { withEndpointCatalog } from './endpoint-catalog'
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

// Overlay a dynamic catalog on top of a built provider: pi.dev's published
// catalog for known upstream types, or the endpoint's own /models for
// everything else with a baseUrl. `discover: false` opts out of both.
//
// `disabled` only gates the endpoint-catalog branch: it stops this task's new
// wrapper from sending the account's own key to the account's own endpoint
// while the account is meant to be off. It does not gate withRemoteCatalog —
// that fetch carries no credential (it hits pi.dev keyed by upstream type),
// so there is no leak to prevent, and a disabled account's static/pi.dev
// catalog listing is pre-existing behavior this task should not change.
//
// A provider that already brings its own `refreshModels` (e.g. antigravity's
// Cloud Code discovery) is left alone rather than matched on `config.baseUrl`
// — `ProviderSchema` permits `baseUrl` on any type, but antigravity ignores it
// and ships its own dynamic catalog, so keying off "config has a baseUrl"
// would silently replace working discovery with a GET to the wrong endpoint.
const wrapProvider = (built: Provider, config: ProviderConfig): Provider => {
  if (config.discover === false) return built
  if (FACTORIES[config.type]) return withRemoteCatalog(built, config.type)
  if (built.refreshModels) return built
  if (!config.baseUrl || config.account.disabled === true) return built
  return withEndpointCatalog(
    built,
    config.account.credential === 'key' ? { apiKey: config.account.key } : {}
  )
}

export const buildModels = (options: RouterOptions, dirs: BuildDirs): MutableModels => {
  const models = createModels({
    credentials: fileCredentialStore(dirs.authDir, options),
    modelsStore: fileModelsStore(join(dirs.stateDir, 'models'))
  })
  for (const [name, config] of Object.entries(options.providers)) {
    const built = buildOne(name, config)
    if (!built) continue
    models.setProvider(wrapProvider(built, config))
  }
  return models
}
