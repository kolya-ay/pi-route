// src/types.ts

// === Backend ===

export type BackendType = 'passthrough-anthropic' | 'passthrough-openai' | 'pi-ai'

export type Backend = {
  readonly name: string
  readonly type: BackendType
  dispatch(request: IncomingRequest, account: Account): Promise<BackendResponse>
}

export type IncomingRequest = {
  id: string
  format: 'anthropic' | 'openai'
  rawRequest: Request
  model: string
  stream: boolean
}

export type BackendResponse = {
  status: number
  headers: Headers
  body: ReadableStream | Record<string, unknown>
  metadata: ResponseMetadata
}

export type ResponseMetadata = {
  requestId: string
  backend: string
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

export type RoutingDecision = { backend: string; model?: string | undefined; reason: string }

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

export type AccountType =
  | 'api-key'
  | 'claude-cli'
  | 'anthropic-oauth'
  | 'copilot-oauth'
  | 'codex-oauth'
  | 'antigravity-oauth'

export type Account = {
  type: AccountType
  name: string
  resolveKey?: (() => string | Promise<string>) | undefined
}

// === Telemetry ===

export type TelemetrySink = { emit(event: TelemetryEvent): void }

export type TelemetryEmitter = { sinks: TelemetrySink[]; emit(event: TelemetryEvent): void }

export type TelemetryEvent =
  | RequestStartEvent
  | RequestEndEvent
  | BackendErrorEvent
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
  backend: string
  model: string
  account?: string | undefined
  tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number } | undefined
  cost?: { input: number; output: number; total: number } | undefined
  latencyMs: number
  error?: string | undefined
}

export type BackendErrorEvent = {
  type: 'backend_error'
  requestId: string
  backend: string
  account?: string | undefined
  status?: number | undefined
  message: string
}

export type RateLimitEvent = {
  type: 'ratelimit_hit'
  backend: string
  account: string
  model: string
  retryAfterMs: number
}

// === Config ===

export type RouterOptions = {
  server: { port: number; host: string }
  auth: { apiKeys: string[] }
  backends: Record<string, BackendOptions>
  routing: RoutingOptions
  telemetry: TelemetryOptions
}

export type BackendOptions = {
  type: BackendType
  baseUrl: string
  provider?: string | undefined
  accounts: Account[]
  balancing: BalancingOptions
}

export type BalancingOptions = {
  strategy: 'round-robin' | 'sticky' | 'fill-first'
  rateLimitPerModel?: boolean | undefined
}

export type RoutingOptions = {
  rules: RoutingRule[]
  scenarios: Partial<Record<ScenarioType, { backend: string; model?: string | undefined }>>
  default: { backend: string }
}

export type ScenarioType = 'thinking' | 'long-context' | 'background'

export type RoutingRule = { match: string; backend: string }

export type TelemetryOptions = { level: 'debug' | 'info' | 'warn' | 'error' }
