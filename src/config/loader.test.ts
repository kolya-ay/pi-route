import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { interpolateEnvVars, loadConfig } from './loader'

describe('interpolateEnvVars', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('replaces $VAR with env value', () => {
    process.env['MY_KEY'] = 'secret'
    expect(interpolateEnvVars('$MY_KEY')).toBe('secret')
  })

  it('handles nested object values', () => {
    process.env['DB_PASS'] = 'hunter2'
    const result = interpolateEnvVars({ nested: { key: '$DB_PASS' } })
    expect(result).toEqual({ nested: { key: 'hunter2' } })
  })

  it('handles array values', () => {
    process.env['TOKEN'] = 'abc123'
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
    delete process.env['MISSING_VAR']
    expect(() => interpolateEnvVars('$MISSING_VAR')).toThrow(
      /Environment variable "MISSING_VAR" is not set/,
    )
  })
})

describe('loadConfig', () => {
  const minimalBackend = {
    type: 'passthrough-anthropic',
    baseUrl: 'https://api.anthropic.com',
    accounts: [],
    balancing: { strategy: 'round-robin' },
  }

  it('loads and parses a JSON file', () => {
    const config = {
      backends: { primary: minimalBackend },
      routing: { default: { backend: 'primary' } },
    }
    const filePath = join(tmpdir(), `hono-router-test-${Date.now()}.json`)
    writeFileSync(filePath, JSON.stringify(config))
    const result = loadConfig(filePath)
    expect(result.backends['primary']?.type).toBe('passthrough-anthropic')
    expect(result.server.port).toBe(3000)
  })

  it('interpolates env vars from file', () => {
    process.env['TEST_API_KEY'] = 'sk-loaded'
    const config = {
      backends: { primary: minimalBackend },
      routing: { default: { backend: 'primary' } },
      auth: { apiKeys: ['$TEST_API_KEY'] },
    }
    const filePath = join(tmpdir(), `hono-router-test-${Date.now()}.json`)
    writeFileSync(filePath, JSON.stringify(config))
    const result = loadConfig(filePath)
    expect(result.auth.apiKeys).toEqual(['sk-loaded'])
    delete process.env['TEST_API_KEY']
  })

  it('throws on missing file', () => {
    expect(() => loadConfig('/nonexistent/path/config.json')).toThrow()
  })

  it('throws on invalid JSON', () => {
    const filePath = join(tmpdir(), `hono-router-test-invalid-${Date.now()}.json`)
    writeFileSync(filePath, 'not valid json {{{')
    expect(() => loadConfig(filePath)).toThrow()
  })

  it('throws on config that fails schema validation', () => {
    const filePath = join(tmpdir(), `hono-router-test-bad-schema-${Date.now()}.json`)
    writeFileSync(filePath, JSON.stringify({ backends: {}, routing: {} }))
    expect(() => loadConfig(filePath)).toThrow()
  })
})
