// src/auth/name-derivers.test.ts

import { describe, expect, it } from 'bun:test'
import type { OAuthCredentials } from '@mariozechner/pi-ai/oauth'
import { deriveName } from './name-derivers'

const makeJwt = (payload: Record<string, unknown>): string => {
  const enc = (v: unknown) => btoa(JSON.stringify(v))
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`
}

const cred = (access: string): OAuthCredentials => ({
  access,
  refresh: 'r',
  expires: Date.now() + 3600_000
})

describe('deriveName', () => {
  it('openai-codex: extracts email from profile claim', () => {
    const token = makeJwt({ 'https://api.openai.com/profile': { email: 'me@example.com' } })
    expect(deriveName('openai-codex', cred(token))).toBe('me@example.com')
  })

  it('openai-codex: falls back to top-level email claim', () => {
    const token = makeJwt({ email: 'fallback@example.com' })
    expect(deriveName('openai-codex', cred(token))).toBe('fallback@example.com')
  })

  it('openai-codex: returns null for malformed JWT', () => {
    expect(deriveName('openai-codex', cred('not-a-jwt'))).toBeNull()
  })

  it('openai-codex: returns null when no email claim present', () => {
    const token = makeJwt({ sub: '123' })
    expect(deriveName('openai-codex', cred(token))).toBeNull()
  })

  it('anthropic: returns null (no derivation)', () => {
    expect(deriveName('anthropic', cred('sk-ant-oat01-xxx'))).toBeNull()
  })

  it('google-antigravity: returns null (no derivation)', () => {
    expect(deriveName('google-antigravity', cred('ya29.xxx'))).toBeNull()
  })

  it('unknown provider: returns null', () => {
    expect(deriveName('bogus', cred('x'))).toBeNull()
  })
})
