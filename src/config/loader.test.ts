import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { interpolateEnvVars } from './loader'

describe('interpolateEnvVars', () => {
  const savedEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...savedEnv }
  })

  afterEach(() => {
    process.env = savedEnv
  })

  it('replaces $VAR with env value', () => {
    process.env.MY_KEY = 'secret'
    expect(interpolateEnvVars('$MY_KEY')).toBe('secret')
  })

  it('handles nested object values', () => {
    process.env.DB_PASS = 'hunter2'
    const result = interpolateEnvVars({ nested: { key: '$DB_PASS' } })
    expect(result).toEqual({ nested: { key: 'hunter2' } })
  })

  it('handles array values', () => {
    process.env.TOKEN = 'abc123'
    const result = interpolateEnvVars(['plain', '$TOKEN'])
    expect(result).toEqual(['plain', 'abc123'])
  })

  it('leaves non-$ strings untouched', () => {
    expect(interpolateEnvVars('hello')).toBe('hello')
    expect(interpolateEnvVars('https://example.com')).toBe('https://example.com')
  })

  it('passes through non-string primitives unchanged', () => {
    expect(interpolateEnvVars(42)).toBe(42)
    expect(interpolateEnvVars(true)).toBe(true)
    expect(interpolateEnvVars(null)).toBe(null)
  })

  it('throws on undefined env var', () => {
    delete process.env.MISSING_VAR
    expect(() => interpolateEnvVars('$MISSING_VAR')).toThrow(
      /Environment variable "MISSING_VAR" is not set/
    )
  })
})
