import { ensureAntigravityOAuthRegistered } from '../auth/antigravity-oauth'
import { ensureOpenAICodexOAuthRegistered } from '../auth/openai-codex-oauth'
import { createAccountPool } from '../balancing/account-pool'
import {
  createFillFirstStrategy,
  createRoundRobinStrategy,
  createStickyStrategy
} from '../balancing/strategies'
import type { RouterState } from '../state'
import type { Provider, ProviderOptions } from '../types'
import { createAntigravityProvider } from './antigravity'
import { createOpenAICodexProvider } from './openai-codex'
import { createPassthroughProvider } from './passthrough'

export type ProviderEntry = { provider: Provider; pool: ReturnType<typeof createAccountPool> }

const buildProvider = (name: string, config: ProviderOptions): Provider => {
  if (config.type === 'antigravity') {
    ensureAntigravityOAuthRegistered()
    return createAntigravityProvider(
      name,
      config.baseUrl ?? 'https://daily-cloudcode-pa.googleapis.com'
    )
  }
  if (config.type === 'openai-codex') {
    ensureOpenAICodexOAuthRegistered()
    return createOpenAICodexProvider(name)
  }
  return createPassthroughProvider(name, config.type, config.baseUrl ?? '')
}

export const createProviderRegistry = (state: RouterState): Map<string, ProviderEntry> => {
  const registry = new Map<string, ProviderEntry>()

  for (const [name, config] of Object.entries(state.options.providers)) {
    const provider = buildProvider(name, config)

    const strategy =
      config.balancing.strategy === 'round-robin'
        ? createRoundRobinStrategy()
        : config.balancing.strategy === 'sticky'
          ? createStickyStrategy()
          : createFillFirstStrategy()

    const pool = createAccountPool(
      () => state.options.providers[name]?.accounts ?? [],
      strategy,
      config.balancing.rateLimitPerModel ?? false
    )

    registry.set(name, { provider, pool })
  }

  return registry
}
