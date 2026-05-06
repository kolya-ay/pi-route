import { createAccountPool } from '../balancing/account-pool'
import {
  createFillFirstStrategy,
  createRoundRobinStrategy,
  createStickyStrategy
} from '../balancing/strategies'
import type { Provider, RouterOptions } from '../types'
import { ensureAntigravityOAuthRegistered } from '../auth/antigravity-oauth'

import { createPassthroughProvider } from './passthrough'
import { createAntigravityProvider } from './antigravity'

export type ProviderEntry = { provider: Provider; pool: ReturnType<typeof createAccountPool> }

export const createProviderRegistry = (options: RouterOptions): Map<string, ProviderEntry> => {
  const registry = new Map<string, ProviderEntry>()

  for (const [name, config] of Object.entries(options.providers)) {
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
      config.accounts,
      strategy,
      config.balancing.rateLimitPerModel ?? false
    )

    registry.set(name, { provider, pool })
  }

  return registry
}
