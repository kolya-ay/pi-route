import { decodeJwt } from './auth/jwt'
import { resolveCredential } from './auth/resolve'
import type { RouterState } from './state'
import type { Tel } from './telemetry/tel'
import type { Account, ProviderConfig } from './types'

export type LimitWindow = {
  used_percent: number
  resets_at: string | null
}

export type LimitCredits = {
  used: number
  cap: number
  currency: string
}

export type ProviderLimitSnapshot = {
  name: string
  type: 'anthropic' | 'openai-codex'
  display_name: string
  status: 'ok' | 'unauthenticated' | 'error'
  plan: string | null
  session: LimitWindow | null
  weekly: LimitWindow | null
  credits: LimitCredits | null
  error_message: string | null
  last_updated: string | null
}

export type LimitsSnapshot = {
  providers: ProviderLimitSnapshot[]
}

const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth'

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

const asNumber = (value: unknown): number | null => (typeof value === 'number' ? value : null)

const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1)

const toWindow = (
  value: unknown,
  usedKey: 'utilization' | 'used_percent',
  resetKey: 'resets_at' | 'reset_at'
) => {
  const record = asRecord(value)
  if (!record) return null

  const used = asNumber(record[usedKey])
  if (used === null) return null

  const resets = record[resetKey]
  return {
    used_percent: used,
    resets_at: typeof resets === 'string' ? resets : null
  }
}

const unauthenticated = (
  name: string,
  type: 'anthropic' | 'openai-codex',
  displayName: string,
  message: string
): ProviderLimitSnapshot => ({
  name,
  type,
  display_name: displayName,
  status: 'unauthenticated',
  plan: null,
  session: null,
  weekly: null,
  credits: null,
  error_message: message,
  last_updated: null
})

const failed = (
  name: string,
  type: 'anthropic' | 'openai-codex',
  displayName: string,
  message: string
): ProviderLimitSnapshot => ({
  name,
  type,
  display_name: displayName,
  status: 'error',
  plan: null,
  session: null,
  weekly: null,
  credits: null,
  error_message: message,
  last_updated: null
})

const anthropicPlan = (payload: Record<string, unknown>): string | null => {
  const tier = asString(payload.rate_limit_tier)
  if (tier === 'default_max_20x') return 'Max 20x'
  if (tier === 'default_max_5x') return 'Max 5x'
  if (tier === 'default_pro') return 'Pro'

  const subscription = asString(payload.subscription_type)
  return subscription ? capitalize(subscription) : null
}

const anthropicCredits = (payload: Record<string, unknown>): LimitCredits | null => {
  const extraUsage = asRecord(payload.extra_usage)
  if (extraUsage?.is_enabled !== true) return null

  const used = asNumber(extraUsage.used_credits)
  const cap = asNumber(extraUsage.monthly_limit)
  return used !== null && cap !== null ? { used, cap, currency: 'USD' } : null
}

const codexPlan = (payload: Record<string, unknown>): string | null => {
  const plan = asString(payload.plan_type)
  if (!plan) return null
  if (plan === 'plus') return 'Plus'
  if (plan === 'pro') return 'Pro'
  if (plan === 'team') return 'Team'
  if (plan === 'free') return 'Free'
  return capitalize(plan)
}

const codexCredits = (payload: Record<string, unknown>): LimitCredits | null => {
  const credits = asRecord(payload.credits)
  if (credits?.has_credits !== true) return null

  const used = asNumber(credits.balance)
  return used !== null ? { used, cap: 0, currency: 'USD' } : null
}

const codexAccountId = (token: string): string | null => {
  const payload = decodeJwt(token)
  if (!payload) return null

  const auth = asRecord(payload[OPENAI_AUTH_CLAIM])
  return auth ? asString(auth.chatgpt_account_id) : null
}

const parseJson = async (response: Response): Promise<Record<string, unknown> | null> => {
  try {
    return asRecord(await response.json())
  } catch {
    return null
  }
}

const collectAnthropicLimits = async (
  name: string,
  account: Account,
  state: RouterState,
  tel: Tel
): Promise<ProviderLimitSnapshot> => {
  if (account.credential !== 'oauth') {
    return unauthenticated(
      name,
      'anthropic',
      'Claude Code',
      'OAuth login required for Claude Code usage.'
    )
  }

  const cred = await resolveCredential(state, account, tel)
  if (!cred) {
    return unauthenticated(
      name,
      'anthropic',
      'Claude Code',
      'OAuth login required for Claude Code usage.'
    )
  }

  const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${cred.access.trim()}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code/2.1.69'
    }
  })

  if (response.status === 401 || response.status === 403) {
    return failed(name, 'anthropic', 'Claude Code', 'Re-authenticate in Claude Code.')
  }

  if (!response.ok) {
    return failed(name, 'anthropic', 'Claude Code', `Usage request failed (${response.status}).`)
  }

  const payload = await parseJson(response)
  if (!payload) {
    return failed(name, 'anthropic', 'Claude Code', "Couldn't read usage.")
  }

  return {
    name,
    type: 'anthropic',
    display_name: 'Claude Code',
    status: 'ok',
    plan: anthropicPlan(payload),
    session: toWindow(payload.five_hour, 'utilization', 'resets_at'),
    weekly: toWindow(payload.seven_day, 'utilization', 'resets_at'),
    credits: anthropicCredits(payload),
    error_message: null,
    last_updated: new Date().toISOString()
  }
}

const collectCodexLimits = async (
  name: string,
  account: Account,
  state: RouterState,
  tel: Tel
): Promise<ProviderLimitSnapshot> => {
  if (account.credential !== 'oauth') {
    return unauthenticated(name, 'openai-codex', 'Codex', 'OAuth login required for Codex usage.')
  }

  const cred = await resolveCredential(state, account, tel)
  if (!cred) {
    return unauthenticated(name, 'openai-codex', 'Codex', 'OAuth login required for Codex usage.')
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${cred.access}`,
    Accept: 'application/json',
    'User-Agent': 'ai-usage-kde'
  }
  const accountId = codexAccountId(cred.access)
  if (accountId) headers['ChatGPT-Account-Id'] = accountId

  const response = await fetch('https://chatgpt.com/backend-api/wham/usage', { headers })
  if (response.status === 401 || response.status === 403) {
    return failed(name, 'openai-codex', 'Codex', 'Re-authenticate in the Codex CLI.')
  }

  if (!response.ok) {
    return failed(name, 'openai-codex', 'Codex', `Usage request failed (${response.status}).`)
  }

  const payload = await parseJson(response)
  if (!payload) {
    return failed(name, 'openai-codex', 'Codex', "Couldn't read usage.")
  }

  const rateLimit = asRecord(payload.rate_limit)
  return {
    name,
    type: 'openai-codex',
    display_name: 'Codex',
    status: 'ok',
    plan: codexPlan(payload),
    session: toWindow(rateLimit?.primary_window, 'used_percent', 'reset_at'),
    weekly: toWindow(rateLimit?.secondary_window, 'used_percent', 'reset_at'),
    credits: codexCredits(payload),
    error_message: null,
    last_updated: new Date().toISOString()
  }
}

const collectProviderLimits = async (
  name: string,
  config: ProviderConfig,
  state: RouterState,
  tel: Tel
): Promise<ProviderLimitSnapshot | null> => {
  try {
    if (config.type === 'anthropic') {
      return await collectAnthropicLimits(name, config.account, state, tel)
    }

    if (config.type === 'openai-codex') {
      return await collectCodexLimits(name, config.account, state, tel)
    }
  } catch {
    if (config.type === 'anthropic') {
      return failed(name, 'anthropic', 'Claude Code', 'Usage request failed.')
    }

    if (config.type === 'openai-codex') {
      return failed(name, 'openai-codex', 'Codex', 'Usage request failed.')
    }
  }

  return null
}

export const collectLimitsSnapshot = async (
  state: RouterState,
  tel: Tel
): Promise<LimitsSnapshot> => {
  const providers = await Promise.all(
    Object.entries(state.options.providers).map(([name, config]) =>
      collectProviderLimits(name, config, state, tel)
    )
  )

  return {
    providers: providers.filter((provider): provider is ProviderLimitSnapshot => provider !== null)
  }
}
