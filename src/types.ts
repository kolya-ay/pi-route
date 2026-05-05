// src/types.ts

// === Backend ===

export type BackendType = 'passthrough-anthropic' | 'passthrough-openai' | 'pi-ai'

export interface Backend {
  readonly name: string
  readonly type: BackendType
  dispatch(request: IncomingRequest, account: Account): Promise<BackendResponse>
}

export interface IncomingRequest {
  id: string
  format: 'anthropic' | 'openai'
  rawRequest: Request
  model: string
  stream: boolean
}

export interface BackendResponse {
  status: number
  headers: Headers
  body: ReadableStream | Record<string, unknown>
  metadata: ResponseMetadata
}

export interface ResponseMetadata {
  requestId: string
  backend: string
  model: string
  tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  cost?: { input: number; output: number; total: number }
  latencyMs: number
  account?: string
}

// === Routing ===

export interface RoutingStrategy {
  readonly name: string
  resolve(context: RoutingContext): RoutingDecision | null
}

export interface RoutingContext {
  model: string
  format: 'anthropic' | 'openai'
  headers: Headers
  body: Record<string, unknown>
  options: RouterOptions
}

export interface RoutingDecision {
  backend: string
  model?: string | undefined
  reason: string
}

// === Balancing ===

export interface BalancingStrategy {
  readonly name: string
  pick(accounts: AccountState[]): AccountState | null
}

export interface AccountState {
  account: Account
  rateLimits: Map<string, number>
  lastUsed: number
  lastError?: { message: string; at: number } | undefined
  isInvalid: boolean
  requestCount: number
}

// === Accounts ===

export type Account =
  | { type: 'api-key'; name: string; key: string }
  | { type: 'claude-cli'; name: string; tokenPath: string }
  | { type: 'anthropic-oauth'; name: string; credentials?: OAuthCredentials | undefined }
  | { type: 'copilot-oauth'; name: string; credentials?: OAuthCredentials | undefined }
  | { type: 'codex-oauth'; name: string; credentials?: OAuthCredentials | undefined }
  | { type: 'antigravity-oauth'; name: string; credentials?: OAuthCredentials | undefined }

export interface OAuthCredentials {
  refresh: string
  access: string
  expires: number
}

// === Telemetry ===

export interface TelemetrySink {
  emit(event: TelemetryEvent): void
}

export interface TelemetryEmitter {
  sinks: TelemetrySink[]
  emit(event: TelemetryEvent): void
}

export type TelemetryEvent =
  | RequestStartEvent
  | RequestEndEvent
  | BackendErrorEvent
  | RateLimitEvent

export interface RequestStartEvent {
  type: 'request_start'
  requestId: string
  timestamp: number
  format: 'anthropic' | 'openai'
  model: string
  stream: boolean
}

export interface RequestEndEvent {
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

export interface BackendErrorEvent {
  type: 'backend_error'
  requestId: string
  backend: string
  account?: string | undefined
  status?: number | undefined
  message: string
}

export interface RateLimitEvent {
  type: 'ratelimit_hit'
  backend: string
  account: string
  model: string
  retryAfterMs: number
}

// === Config ===

export interface RouterOptions {
  server: { port: number; host: string }
  auth: { apiKeys: string[] }
  backends: Record<string, BackendOptions>
  routing: RoutingOptions
  telemetry: TelemetryOptions
}

export interface BackendOptions {
  type: BackendType
  baseUrl: string
  provider?: string | undefined
  accounts: Account[]
  balancing: BalancingOptions
}

export interface BalancingOptions {
  strategy: 'round-robin' | 'sticky' | 'fill-first'
  rateLimitPerModel?: boolean | undefined
}

export interface RoutingOptions {
  rules: RoutingRule[]
  scenarios: Partial<Record<ScenarioType, { backend: string; model?: string | undefined }>>
  default: { backend: string }
}

export type ScenarioType = 'thinking' | 'long-context' | 'background'

export interface RoutingRule {
  match: string
  backend: string
}

export interface TelemetryOptions {
  level: 'debug' | 'info' | 'warn' | 'error'
}
