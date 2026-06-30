// src/types.ts

import type { OAuthCredentials } from '@mariozechner/pi-ai/oauth'
import type { Span } from '@opentelemetry/api'

import type { CaptureOpts } from './telemetry/capture'
import type { Tel } from './telemetry/tel'

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

// Telemetry hooks threaded from dispatch.ts to providers so pi-ai-runtime can
// wrap event streams with TTFT/tokens/cost recording and optional prompt
// capture. Optional — non-pi-ai providers (passthrough, antigravity) ignore it.
export type TelHooks = {
  tel: Tel
  span: Span
  capture: CaptureOpts
}

export type IncomingRequest = {
  id: string
  format: 'anthropic' | 'openai' | 'responses'
  rawRequest: Request
  model: string
  stream: boolean
  telHooks?: TelHooks
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

// === Config ===

export type ProviderConfig = {
  type: ProviderType
  baseUrl?: string | undefined
  account: Account
}

export type BalancingStrategyName = 'round-robin' | 'sticky' | 'fill-first' | 'failover'

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
