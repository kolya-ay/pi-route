import { describe, expect, it } from 'bun:test'
import { discoverEmail } from './openai-codex-oauth'

const makeJwt = (payload: Record<string, unknown>): string => {
  const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }))
  const body = btoa(JSON.stringify(payload))
  return `${header}.${body}.sig`
}

describe('discoverEmail', () => {
  it('returns the email from the namespaced OpenAI profile claim', () => {
    const token = makeJwt({
      'https://api.openai.com/profile': { email: 'user@example.com' },
      sub: 'abc'
    })
    expect(discoverEmail(token)).toBe('user@example.com')
  })

  it('prefers the namespaced claim over a stray top-level email', () => {
    const token = makeJwt({
      'https://api.openai.com/profile': { email: 'real@example.com' },
      email: 'stale@example.com'
    })
    expect(discoverEmail(token)).toBe('real@example.com')
  })

  it('falls back to a top-level email claim when namespaced profile is absent', () => {
    const token = makeJwt({ email: 'user@example.com', sub: 'abc' })
    expect(discoverEmail(token)).toBe('user@example.com')
  })

  it('throws with a JWT-shape dump when the email claim is missing', () => {
    const token = makeJwt({ sub: 'abc' })
    expect(() => discoverEmail(token)).toThrow(/email/)
    expect(() => discoverEmail(token)).toThrow(/JWT payload keys:.*sub/)
  })

  it('throws with a clear message when the token is malformed', () => {
    expect(() => discoverEmail('not-a-jwt')).toThrow(/JWT/)
  })
})
