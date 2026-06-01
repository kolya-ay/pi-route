import { ensureAntigravityOAuthRegistered } from '../auth/antigravity-oauth'
import { createAccountPool } from '../balancing/account-pool'
import {
  createFillFirstStrategy,
  createRoundRobinStrategy,
  createStickyStrategy
} from '../balancing/strategies'
import type { RouterState } from '../state'
import type { Provider } from '../types'
import { createAntigravityProvider } from './antigravity'
import { createPassthroughProvider } from './passthrough'

export type ProviderEntry = { provider: Provider; pool: ReturnType<typeof createAccountPool> }

export const createProviderRegistry = (state: RouterState): Map<string, ProviderEntry> => {
  const registry = new Map<string, ProviderEntry>()

  for (const [name, config] of Object.entries(state.options.providers)) {
    const provider =
      config.type === 'antigravity'
        ? (() => {
            ensureAntigravityOAuthRegistered()
            return createAntigravityProvider(
              name,
              config.baseUrl ?? 'https://daily-cloudcode-pa.googleapis.com'
            )
          })()
        : createPassthroughProvider(name, config.type, config.baseUrl ?? '')

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
