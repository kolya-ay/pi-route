// src/auth/name-derivers.ts

import type { OAuthCredentials } from '@mariozechner/pi-ai/oauth'

const decodeJwt = (token: string): Record<string, unknown> | null => {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    return JSON.parse(atob(parts[1] ?? '')) as Record<string, unknown>
  } catch {
    return null
  }
}

// OpenAI's access-token JWT follows Auth0's namespaced custom-claims convention:
// user-identifying fields live under the URL-keyed `profile` object, not at the
// top level. Top-level `email` is a defensive fallback in case the shape changes.
const OPENAI_PROFILE_CLAIM = 'https://api.openai.com/profile'

const derivers: Record<string, (c: OAuthCredentials) => string | null> = {
  'openai-codex': (c) => {
    const payload = decodeJwt(c.access)
    if (!payload) return null
    const profile = payload[OPENAI_PROFILE_CLAIM] as { email?: unknown } | undefined
    const email = profile?.email ?? payload.email
    return typeof email === 'string' && email.length > 0 ? email : null
  }
}

export const deriveName = (providerType: string, creds: OAuthCredentials): string | null =>
  derivers[providerType]?.(creds) ?? null
