// src/backends/registry.ts

import { createAccountPool } from '../balancing/account-pool.js'
import {
  createFillFirstStrategy,
  createRoundRobinStrategy,
  createStickyStrategy,
} from '../balancing/strategies.js'
import type { Backend, RouterOptions } from '../types.js'
import { createPiAiBackend } from './pi-ai/backend.js'
import { createPassthroughAnthropicBackend } from './passthrough-anthropic.js'
import { createPassthroughOpenAIBackend } from './passthrough-openai.js'

export interface BackendEntry {
  backend: Backend
  pool: ReturnType<typeof createAccountPool>
}

export const createBackendRegistry = (options: RouterOptions): Map<string, BackendEntry> => {
  const registry = new Map<string, BackendEntry>()

  for (const [name, config] of Object.entries(options.backends)) {
    const backend =
      config.type === 'passthrough-anthropic'
        ? createPassthroughAnthropicBackend(name)
        : config.type === 'passthrough-openai'
          ? createPassthroughOpenAIBackend(name, config.baseUrl)
          : config.type === 'pi-ai'
            ? createPiAiBackend(name, config.provider ?? '')
            : (() => {
                throw new Error(`Backend type '${config.type}' not yet implemented`)
              })()

    const strategy =
      config.balancing.strategy === 'round-robin'
        ? createRoundRobinStrategy()
        : config.balancing.strategy === 'sticky'
          ? createStickyStrategy()
          : createFillFirstStrategy()

    const pool = createAccountPool(
      config.accounts,
      strategy,
      config.balancing.rateLimitPerModel ?? false,
    )

    registry.set(name, { backend, pool })
  }

  return registry
}
