// src/types.ts

import type { OAuthCredentials } from '@mariozechner/pi-ai/oauth'

// === Provider ===

export type ProviderType =
  | 'anthropic'
  | 'openai'
  | 'openai-compatible'
  | 'antigravity'
  | 'openai-codex'
  | 'cerebras'
  | 'openrouter'
  | (string & {}) // accept any string; the `& {}` preserves the literal-completion hints

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

// === Accounts ===

export type CredentialFile = OAuthCredentials & {
  provider: string
}

export type Account = { disabled?: boolean | undefined } & (
  | { credential: 'key'; key: string }
  | { credential: 'oauth'; name: string; projectId?: string | undefined }
)

// === Telemetry ===

export type TelemetrySink = { emit(event: TelemetryEvent): void }

export type TelemetryEmitter = { sinks: TelemetrySink[]; emit(event: TelemetryEvent): void }

export type TelemetryEvent =
  | RequestStartEvent
  | RequestEndEvent
  | ProviderErrorEvent
  | RateLimitEvent
  | AccountRefreshedEvent
  | AccountRefreshFailedEvent
  | AccountRefreshGivenUpEvent

export type AccountRefreshedEvent = {
  type: 'account.refreshed'
  account: string
  expires: number
}

export type AccountRefreshFailedEvent = {
  type: 'account.refresh-failed'
  account: string
  error: string
}

export type AccountRefreshGivenUpEvent = {
  type: 'account.refresh-given-up'
  account: string
  attempts: number
}

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

export type ProviderConfig = {
  type: ProviderType
  baseUrl?: string | undefined
  account: Account
}

export type BalancingStrategyName = 'round-robin' | 'sticky' | 'fill-first'

export type PipelineEntry =
  | { kind: 'alias'; name: string; target: string }
  | {
      kind: 'pool'
      name: string
      to: string[]
      strategy: BalancingStrategyName
      when?: { thinking?: boolean | undefined } | undefined
    }

export type RouterOptions = {
  providers: Record<string, ProviderConfig>
  pipeline: PipelineEntry[] // ordered
  expose: string[] // gitignore-style globs; empty = all
}
