import { registerAllOAuthProviders } from '../auth/register-all-oauth'
import type { RouterState } from '../state'
import type { Account, Provider, ProviderConfig } from '../types'
import { createAnthropicProvider } from './anthropic'
import { createAntigravityProvider } from './antigravity'
import { createOpenAICodexProvider } from './openai-codex'
import { createOpenAICompletionsProvider } from './openai-completions'
import { createPassthroughProvider } from './passthrough'

export type ProviderEntry = { provider: Provider; account: Account }

const DEFAULT_BASE_URLS: Partial<Record<string, string>> = {
  // Each base URL must include the provider's API-version prefix; the
  // passthrough joins inbound endpoint tails (e.g. `chat/completions`) onto
  // the base as a relative path.
  openai: 'https://api.openai.com/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  antigravity: 'https://daily-cloudcode-pa.googleapis.com',
  'openai-compatible': '' // explicit: user must supply
}

export const resolveBaseUrl = (type: string, configured?: string): string => {
  if (configured !== undefined) return configured
  return DEFAULT_BASE_URLS[type] ?? ''
}

const PASSTHROUGH_TYPES = ['openai']
const OPENAI_COMPLETIONS_TYPES = ['openai-compatible', 'cerebras', 'openrouter']

const buildProvider = (name: string, config: ProviderConfig): Provider => {
  const baseUrl = resolveBaseUrl(config.type, config.baseUrl)
  if (config.type === 'antigravity') {
    return createAntigravityProvider(name, baseUrl)
  }
  if (config.type === 'openai-codex') {
    return createOpenAICodexProvider(name)
  }
  if (config.type === 'anthropic') {
    return createAnthropicProvider(name)
  }
  if (OPENAI_COMPLETIONS_TYPES.includes(config.type)) {
    return createOpenAICompletionsProvider(name, config.type, baseUrl)
  }
  return createPassthroughProvider(name, config.type, baseUrl)
}

export const createProviderRegistry = (state: RouterState): Map<string, ProviderEntry> => {
  registerAllOAuthProviders()
  const registry = new Map<string, ProviderEntry>()
  for (const [name, config] of Object.entries(state.options.providers)) {
    const provider = buildProvider(name, config)
    const needsBaseUrl =
      PASSTHROUGH_TYPES.includes(config.type) || OPENAI_COMPLETIONS_TYPES.includes(config.type)
    if (needsBaseUrl && !resolveBaseUrl(config.type, config.baseUrl)) {
      throw new Error(`provider "${name}" (type ${config.type}) requires baseUrl`)
    }
    registry.set(name, { provider, account: config.account })
  }
  return registry
}
