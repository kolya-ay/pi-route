import { decodeJwt } from './auth/jwt'
import type { RouterState } from './state'
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

export type LimitScopedWindow = LimitWindow & {
  kind: string
  window_seconds: number | null
  active: boolean
  scope: string | null // e.g. a per-model weekly cap: "Fable"
}

export type LimitSpend = {
  used: number
  cap: number | null
  currency: string
  enabled: boolean
  disabled_reason: string | null
}

export type LimitAccount = {
  email: string | null
  organization_type: string | null
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
  windows: LimitScopedWindow[]
  spend: LimitSpend | null
  account: LimitAccount | null
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

const WEEK_SECONDS = 7 * 24 * 60 * 60

const toIso = (value: unknown): string | null => {
  if (typeof value === 'string' && value.length > 0) return value
  // Codex reports reset_at as epoch seconds. A non-positive value is treated as
  // unset rather than a genuine 1970 reset (a sentinel zero is far likelier),
  // and a value outside Date's range degrades to null instead of throwing.
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  const date = new Date(value * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

const toWindow = (
  value: unknown,
  usedKey: 'utilization' | 'used_percent',
  resetKey: 'resets_at' | 'reset_at'
) => {
  const record = asRecord(value)
  if (!record) return null

  const used = asNumber(record[usedKey])
  if (used === null) return null

  return {
    used_percent: used,
    resets_at: toIso(record[resetKey])
  }
}

// display_name is a pure function of type — no call site ever supplies a
// different name for the same type.
const displayName = (type: 'anthropic' | 'openai-codex'): string =>
  type === 'anthropic' ? 'Claude Code' : 'Codex'

const stub = (
  name: string,
  type: 'anthropic' | 'openai-codex',
  status: 'unauthenticated' | 'error',
  message: string
): ProviderLimitSnapshot => ({
  name,
  type,
  display_name: displayName(type),
  status,
  plan: null,
  session: null,
  weekly: null,
  credits: null,
  windows: [],
  spend: null,
  account: null,
  error_message: message,
  last_updated: null
})

// Tier strings have been spelled `default_max_5x` and `default_claude_max_5x`;
// parse the shape instead of tabling the spellings, so the next rename does not
// silently blank the column.
export const planFromTier = (tier: string | null): string | null => {
  if (!tier) return null
  const core = tier.replace(/^default_/, '').replace(/^claude_/, '')
  const max = /^max_(\d+)x$/.exec(core)
  return max ? `Max ${max[1]}x` : capitalize(core.replace(/_/g, ' '))
}

// `limits[]` carries every window the account has, including per-model weekly
// caps that the two-window shape cannot express.
const anthropicWindows = (payload: Record<string, unknown>): LimitScopedWindow[] => {
  const raw = Array.isArray(payload.limits) ? payload.limits : []
  return raw.flatMap((entry) => {
    const record = asRecord(entry)
    const percent = asNumber(record?.percent)
    const kind = asString(record?.kind)
    if (!record || percent === null || !kind) return []
    const model = asRecord(asRecord(record.scope)?.model)
    return [
      {
        kind,
        used_percent: percent,
        resets_at: toIso(record.resets_at),
        window_seconds: null,
        // Absent means unknown, not false.
        active: record.is_active !== false,
        scope: asString(model?.display_name)
      }
    ]
  })
}

// A missing exponent must not be treated as 0 — that would turn 1234 minor
// units into a fabricated 1234.00, not the intended (and unrepresentable) value.
const money = (value: unknown): number | null => {
  const record = asRecord(value)
  const minor = asNumber(record?.amount_minor)
  const exponent = asNumber(record?.exponent)
  return minor === null || exponent === null ? null : minor / 10 ** exponent
}

const anthropicSpend = (payload: Record<string, unknown>): LimitSpend | null => {
  const spend = asRecord(payload.spend)
  if (!spend) return null
  const used = money(spend.used)
  if (used === null) return null
  return {
    used,
    cap: money(spend.limit),
    currency:
      asString(asRecord(spend.used)?.currency) ??
      asString(asRecord(spend.limit)?.currency) ??
      'USD',
    enabled: spend.enabled === true,
    disabled_reason: asString(spend.disabled_reason)
  }
}

// email and organization_type are independently optional; collapse to a single
// `null` when both are absent instead of a hollow object — one encoding of
// "no account info" for the whole wire shape, matching error/unauthenticated rows.
const toAccount = (email: string | null, organizationType: string | null): LimitAccount | null =>
  email === null && organizationType === null
    ? null
    : { email, organization_type: organizationType }

const anthropicCredits = (payload: Record<string, unknown>): LimitCredits | null => {
  const extraUsage = asRecord(payload.extra_usage)
  if (extraUsage?.is_enabled !== true) return null

  const used = asNumber(extraUsage.used_credits)
  const cap = asNumber(extraUsage.monthly_limit)
  return used !== null && cap !== null ? { used, cap, currency: 'USD' } : null
}

const codexPlan = (payload: Record<string, unknown>): string | null => {
  const plan = asString(payload.plan_type)
  return plan ? capitalize(plan) : null
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

const anthropicHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token.trim()}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'anthropic-beta': 'oauth-2025-04-20',
  'User-Agent': 'claude-code/2.1.69'
})

const anthropicProfile = async (token: string): Promise<Record<string, unknown> | null> => {
  try {
    const response = await fetch('https://api.anthropic.com/api/oauth/profile', {
      headers: anthropicHeaders(token)
    })
    return response.ok ? await parseJson(response) : null
  } catch {
    return null
  }
}

const collectAnthropicLimits = async (
  name: string,
  account: Account,
  state: RouterState
): Promise<ProviderLimitSnapshot> => {
  if (account.credential !== 'oauth') {
    return stub(name, 'anthropic', 'unauthenticated', 'OAuth login required for Claude Code usage.')
  }

  const auth = await state.models.getAuth(name)
  const token = auth?.auth.apiKey
  if (!token) {
    return stub(name, 'anthropic', 'unauthenticated', 'OAuth login required for Claude Code usage.')
  }

  const [response, profile] = await Promise.all([
    fetch('https://api.anthropic.com/api/oauth/usage', { headers: anthropicHeaders(token) }),
    anthropicProfile(token)
  ])

  if (response.status === 401 || response.status === 403) {
    return stub(name, 'anthropic', 'error', 'Re-authenticate in Claude Code.')
  }

  if (!response.ok) {
    return stub(name, 'anthropic', 'error', `Usage request failed (${response.status}).`)
  }

  const payload = await parseJson(response)
  if (!payload) {
    return stub(name, 'anthropic', 'error', "Couldn't read usage.")
  }

  return {
    name,
    type: 'anthropic',
    display_name: displayName('anthropic'),
    status: 'ok',
    plan:
      planFromTier(asString(asRecord(profile?.organization)?.rate_limit_tier)) ??
      planFromTier(asString(asRecord(profile?.organization)?.organization_type)),
    session: toWindow(payload.five_hour, 'utilization', 'resets_at'),
    weekly: toWindow(payload.seven_day, 'utilization', 'resets_at'),
    credits: anthropicCredits(payload),
    windows: anthropicWindows(payload),
    spend: anthropicSpend(payload),
    account: toAccount(
      asString(asRecord(profile?.account)?.email),
      asString(asRecord(profile?.organization)?.organization_type)
    ),
    error_message: null,
    last_updated: new Date().toISOString()
  }
}

const collectCodexLimits = async (
  name: string,
  account: Account,
  state: RouterState
): Promise<ProviderLimitSnapshot> => {
  if (account.credential !== 'oauth') {
    return stub(name, 'openai-codex', 'unauthenticated', 'OAuth login required for Codex usage.')
  }

  const auth = await state.models.getAuth(name)
  const token = auth?.auth.apiKey
  if (!token) {
    return stub(name, 'openai-codex', 'unauthenticated', 'OAuth login required for Codex usage.')
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'User-Agent': 'ai-usage-kde'
  }
  const accountId = codexAccountId(token)
  if (accountId) headers['ChatGPT-Account-Id'] = accountId

  const response = await fetch('https://chatgpt.com/backend-api/wham/usage', { headers })
  if (response.status === 401 || response.status === 403) {
    return stub(name, 'openai-codex', 'error', 'Re-authenticate in the Codex CLI.')
  }

  if (!response.ok) {
    return stub(name, 'openai-codex', 'error', `Usage request failed (${response.status}).`)
  }

  const payload = await parseJson(response)
  if (!payload) {
    return stub(name, 'openai-codex', 'error', "Couldn't read usage.")
  }

  const rateLimit = asRecord(payload.rate_limit)
  // The role of a window is its duration, not its slot: codex has served a
  // seven-day window as `primary_window` with `secondary_window` null.
  const windows: LimitScopedWindow[] = [
    rateLimit?.primary_window,
    rateLimit?.secondary_window
  ].flatMap((w) => {
    const parsed = toWindow(w, 'used_percent', 'reset_at')
    if (!parsed) return []
    const seconds = asNumber(asRecord(w)?.limit_window_seconds)
    return [
      {
        ...parsed,
        kind: seconds !== null && seconds >= WEEK_SECONDS ? 'weekly' : 'session',
        window_seconds: seconds,
        active: true,
        scope: null
      }
    ]
  })
  // Projected explicitly: spreading a LimitScopedWindow here would leak kind/
  // window_seconds/active/scope into the lean session/weekly wire fields.
  const pick = (kind: string): LimitWindow | null => {
    const w = windows.find((x) => x.kind === kind)
    return w ? { used_percent: w.used_percent, resets_at: w.resets_at } : null
  }

  return {
    name,
    type: 'openai-codex',
    display_name: displayName('openai-codex'),
    status: 'ok',
    plan: codexPlan(payload),
    session: pick('session'),
    weekly: pick('weekly'),
    credits: codexCredits(payload),
    windows,
    spend: null,
    account: toAccount(asString(payload.email), null),
    error_message: null,
    last_updated: new Date().toISOString()
  }
}

const isLimitsProvider = (type: ProviderConfig['type']): type is 'anthropic' | 'openai-codex' =>
  type === 'anthropic' || type === 'openai-codex'

const collectProviderLimits = async (
  name: string,
  config: ProviderConfig,
  state: RouterState
): Promise<ProviderLimitSnapshot | null> => {
  if (!isLimitsProvider(config.type)) return null

  try {
    return config.type === 'anthropic'
      ? await collectAnthropicLimits(name, config.account, state)
      : await collectCodexLimits(name, config.account, state)
  } catch {
    return stub(name, config.type, 'error', 'Usage request failed.')
  }
}

export const collectLimitsSnapshot = async (state: RouterState): Promise<LimitsSnapshot> => {
  const providers = await Promise.all(
    Object.entries(state.options.providers).map(([name, config]) =>
      collectProviderLimits(name, config, state)
    )
  )

  return {
    providers: providers.filter((provider): provider is ProviderLimitSnapshot => provider !== null)
  }
}
