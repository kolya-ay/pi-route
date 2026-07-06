import { describe, expect, it } from 'bun:test'
import { decodeJwt } from './jwt'

const makeJwt = (payload: Record<string, unknown>): string => {
  const enc = (value: unknown) => btoa(JSON.stringify(value))
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`
}

describe('decodeJwt', () => {
  it('returns the decoded payload for a valid JWT', () => {
    expect(decodeJwt(makeJwt({ sub: '123', role: 'tester' }))).toEqual({
      sub: '123',
      role: 'tester'
    })
  })

  it('decodes a valid base64url JWT payload', () => {
    const token =
      'eyJhbGciOiJub25lIn0.eyJzdWIiOiI2MiIsIngiOiI-IiwiZW1haWwiOiJ1NjJAZXhhbXBsZS5jb20ifQ.sig'
    expect(decodeJwt(token)).toEqual({
      sub: '62',
      x: '>',
      email: 'u62@example.com'
    })
  })

  it('returns null for a malformed token', () => {
    expect(decodeJwt('not-a-jwt')).toBeNull()
  })

  it('returns null for a token with a non-JSON payload', () => {
    const token = `${btoa(JSON.stringify({ alg: 'none' }))}.${btoa('not-json')}.sig`
    expect(decodeJwt(token)).toBeNull()
  })
})
