import { join } from 'node:path'
import type { MutableModels, Provider } from '@earendil-works/pi-ai'
import { createModels, createProvider, envApiKeyAuth } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { cerebrasProvider } from '@earendil-works/pi-ai/providers/cerebras'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'
import { fileCredentialStore } from '../auth/credential-store'
import type { ModelMeta } from '../pipeline/catalog'
import { antigravityProvider } from '../providers/antigravity-provider'
import type { ProviderConfig, RouterOptions } from '../types'
import { withEndpointCatalog, withRemoteCatalog } from './cached-catalog'
import { fileModelsStore } from './store'

// `liveMeta`, when supplied, is the caller's sink for each wrapped provider's
// lossless /models parse — the same map the catalog reads as its live metadata.
export type BuildDirs = {
  stateDir: string
  authDir: string
  liveMeta?: Map<string, ModelMeta>
  // Output sink (like liveMeta): the ids of providers given an endpoint catalog —
  // the wrapper that fetches /models and publishes into liveMeta on its own 4h
  // schedule. enrichLiveMeta reads this to know which providers it must NOT also
  // fetch, decided at build time rather than inferred from liveMeta's contents.
  wrapped?: Set<string>
}

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

const withoutRefresh = (p: Provider): Provider => {
  const { refreshModels: _refreshModels, ...rest } = p
  return rest
}

// Overlay a dynamic catalog on top of a built provider: pi.dev's published
// catalog for known upstream types, or the endpoint's own /models for
// everything else with a baseUrl. `discover: false` opts out of both.
//
// `disabled` must REMOVE `refreshModels`, not merely skip a wrapper.
// `models.refresh()` calls whatever `refreshModels` a provider carries,
// wrapped or not, so returning the built provider untouched stops nothing:
// antigravity ships its own refresh that POSTs the account's OAuth token to
// Google, and it would keep doing so every tick of an account the user turned
// off. Dropping the method is the only gate the refresh loop respects.
//
// withRemoteCatalog is deliberately exempt. That fetch carries no credential
// — it hits pi.dev keyed by upstream type — so there is no leak to prevent,
// and its `refreshModels` is also what restores the persisted catalog from
// the store: stripping it would leave a disabled provider listing nothing,
// a listing regression dressed as a security fix.
//
// The `disabled` check on the endpoint branch still matters: an
// openai-compatible provider brings no `refreshModels` of its own, so it
// never reaches the guard above it.
//
// A disabled antigravity provider does lose its listing, which is correct:
// its catalog only ever existed as a product of the credentialed fetch being
// stopped. `config/availability.ts` already excludes disabled providers from
// dispatch and `cli/provider-config.ts` hides them from `provider list`.
//
// A provider that already brings its own `refreshModels` (e.g. antigravity's
// Cloud Code discovery) is left alone rather than matched on `config.baseUrl`
// — `ProviderSchema` permits `baseUrl` on any type, but antigravity ignores it
// and ships its own dynamic catalog, so keying off "config has a baseUrl"
// would silently replace working discovery with a GET to the wrong endpoint.
const wrapProvider = (
  built: Provider,
  config: ProviderConfig,
  liveMeta?: Map<string, ModelMeta>,
  wrapped?: Set<string>
): Provider => {
  if (config.discover === false) return built
  if (FACTORIES[config.type]) return withRemoteCatalog(built, config.type)
  if (built.refreshModels) {
    return config.account.disabled === true ? withoutRefresh(built) : built
  }
  if (!config.baseUrl || config.account.disabled === true) return built
  wrapped?.add(built.id)
  return withEndpointCatalog(built, {
    ...(config.account.credential === 'key' ? { apiKey: config.account.key } : {}),
    ...(liveMeta ? { liveMeta } : {})
  })
}

export const buildModels = (options: RouterOptions, dirs: BuildDirs): MutableModels => {
  const models = createModels({
    credentials: fileCredentialStore(dirs.authDir, options),
    modelsStore: fileModelsStore(join(dirs.stateDir, 'models'))
  })
  for (const [name, config] of Object.entries(options.providers)) {
    const built = buildOne(name, config)
    if (!built) continue
    models.setProvider(wrapProvider(built, config, dirs.liveMeta, dirs.wrapped))
  }
  return models
}
