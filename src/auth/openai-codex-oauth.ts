// src/auth/openai-codex-oauth.ts

import {
  openaiCodexOAuthProvider,
  loginOpenAICodex as piLoginOpenAICodex,
  refreshOpenAICodexToken,
  registerOAuthProvider
} from '@mariozechner/pi-ai/oauth'

export { piLoginOpenAICodex as loginOpenAICodex, refreshOpenAICodexToken }

const decodeJwtPayload = (token: string): Record<string, unknown> => {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error(`Malformed JWT: expected 3 segments, got ${parts.length}`)
  try {
    return JSON.parse(atob(parts[1] ?? '')) as Record<string, unknown>
  } catch (err) {
    throw new Error(`Malformed JWT payload: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export const discoverEmail = (accessToken: string): string => {
  const payload = decodeJwtPayload(accessToken)
  const email = payload.email
  if (typeof email !== 'string' || email.length === 0) {
    throw new Error(
      `OpenAI Codex access token missing 'email' claim. JWT payload keys: ${Object.keys(payload).join(', ')}`
    )
  }
  return email
}

let registered = false

export const ensureOpenAICodexOAuthRegistered = (): void => {
  if (registered) return
  registerOAuthProvider(openaiCodexOAuthProvider)
  registered = true
}
