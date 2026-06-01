// src/types.ts

// === Provider ===

export type ProviderType = 'anthropic' | 'openai' | 'antigravity'

export type Provider = {
  readonly name: string
  readonly type: ProviderType
  dispatch(request: IncomingRequest, account: Account, apiKey: string): Promise<ProviderResponse>
}

export type IncomingRequest = {
  id: string
  format: 'anthropic' | 'openai'
  rawRequest: Request
  model: string
  stream: boolean
}

export type ProviderResponse = {
  status: number
  headers: Headers
  body: ReadableStream | Record<string, unknown>
  metadata: ResponseMetadata
}

export type ResponseMetadata = {
  requestId: string
  provider: string
  model: string
  tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  cost?: { input: number; output: number; total: number }
  latencyMs: number
  account?: string
}

// === Routing ===

export type RoutingStrategy = {
  readonly name: string
  resolve(context: RoutingContext): RoutingDecision | null
}

export type RoutingContext = {
  model: string
  format: 'anthropic' | 'openai'
  headers: Headers
  body: Record<string, unknown>
  options: RouterOptions
}

export type RoutingDecision = { provider: string; model?: string | undefined; reason: string }

// === Balancing ===

export type BalancingStrategy = {
  readonly name: string
  pick(accounts: AccountState[]): AccountState | null
}

export type AccountState = {
  account: Account
  rateLimits: Map<string, number>
  lastUsed: number
  lastError?: { message: string; at: number } | undefined
  isInvalid: boolean
  requestCount: number
}

// === Accounts ===

export type CredentialFile = {
  provider: string
  refreshToken: string
  accessToken: string
  expires: number
  [key: string]: unknown
}

export type AccountType = 'api-key' | 'claude-cli' | 'antigravity-oauth'

type AccountBase = {
  name: string
  disabled?: boolean | undefined
}

export type ApiKeyAccount = AccountBase & { type: 'api-key'; key: string }
export type ClaudeCliAccount = AccountBase & { type: 'claude-cli'; tokenPath: string }
export type AntigravityOAuthAccount = AccountBase & { type: 'antigravity-oauth' }

export type Account = ApiKeyAccount | ClaudeCliAccount | AntigravityOAuthAccount

// === Telemetry ===

export type TelemetrySink = { emit(event: TelemetryEvent): void }

export type TelemetryEmitter = { sinks: TelemetrySink[]; emit(event: TelemetryEvent): void }

export type TelemetryEvent =
  | RequestStartEvent
  | RequestEndEvent
  | ProviderErrorEvent
  | RateLimitEvent

export type RequestStartEvent = {
  type: 'request_start'
  requestId: string
  timestamp: number
  format: 'anthropic' | 'openai'
  model: string
  stream: boolean
}

export type RequestEndEvent = {
  type: 'request_end'
  requestId: string
  timestamp: number
  status: number
  provider: string
  model: string
  account?: string | undefined
  tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number } | undefined
  cost?: { input: number; output: number; total: number } | undefined
  latencyMs: number
  error?: string | undefined
}

export type ProviderErrorEvent = {
  type: 'provider_error'
  requestId: string
  provider: string
  account?: string | undefined
  status?: number | undefined
  message: string
}

export type RateLimitEvent = {
  type: 'ratelimit_hit'
  provider: string
  account: string
  model: string
  retryAfterMs: number
}

// === Config ===

export type RouterOptions = {
  server: { port: number; host: string }
  auth: { apiKeys: string[] }
  providers: Record<string, ProviderOptions>
  authDir: string
  routing: RoutingOptions
  telemetry: TelemetryOptions
}

export type ProviderOptions = {
  type: ProviderType
  baseUrl?: string | undefined
  accounts: Account[]
  balancing: BalancingOptions
}

export type BalancingOptions = {
  strategy: 'round-robin' | 'sticky' | 'fill-first'
  rateLimitPerModel?: boolean | undefined
}

export type RoutingOptions = {
  rules: RoutingRule[]
  scenarios: Partial<Record<ScenarioType, { provider: string; model?: string | undefined }>>
  default: { provider: string }
}

export type ScenarioType = 'thinking' | 'long-context' | 'background'

export type RoutingRule = { match: string; provider: string }

export type TelemetryOptions = { level: 'debug' | 'info' | 'warn' | 'error' }
