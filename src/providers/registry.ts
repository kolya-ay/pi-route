import { ensureAntigravityOAuthRegistered } from '../auth/antigravity-oauth'
import { ensureOpenAICodexOAuthRegistered } from '../auth/openai-codex-oauth'
import type { RouterState } from '../state'
import type { Account, Provider, ProviderConfig } from '../types'
import { createAntigravityProvider } from './antigravity'
import { createOpenAICodexProvider } from './openai-codex'
import { createPassthroughProvider } from './passthrough'

export type ProviderEntry = { provider: Provider; account: Account }

const DEFAULT_BASE_URLS: Partial<Record<string, string>> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  cerebras: 'https://api.cerebras.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  antigravity: 'https://daily-cloudcode-pa.googleapis.com',
  'openai-compatible': '' // explicit: user must supply
}

export const resolveBaseUrl = (type: string, configured?: string): string => {
  if (configured !== undefined) return configured
  return DEFAULT_BASE_URLS[type] ?? ''
}

const buildProvider = (name: string, config: ProviderConfig): Provider => {
  const baseUrl = resolveBaseUrl(config.type, config.baseUrl)
  if (config.type === 'antigravity') {
    ensureAntigravityOAuthRegistered()
    return createAntigravityProvider(name, baseUrl)
  }
  if (config.type === 'openai-codex') {
    ensureOpenAICodexOAuthRegistered()
    return createOpenAICodexProvider(name)
  }
  return createPassthroughProvider(name, config.type, baseUrl)
}

const PASSTHROUGH_TYPES = ['anthropic', 'openai', 'openai-compatible', 'cerebras', 'openrouter']

export const createProviderRegistry = (state: RouterState): Map<string, ProviderEntry> => {
  const registry = new Map<string, ProviderEntry>()
  for (const [name, config] of Object.entries(state.options.providers)) {
    const provider = buildProvider(name, config)
    if (PASSTHROUGH_TYPES.includes(config.type) && !resolveBaseUrl(config.type, config.baseUrl)) {
      throw new Error(`provider "${name}" (type ${config.type}) requires baseUrl`)
    }
    registry.set(name, { provider, account: config.account })
  }
  return registry
}
