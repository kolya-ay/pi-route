import { describe, expect, it } from 'vitest'
import { parseConfig } from './schema'

const minimalBackend = {
  type: 'passthrough-anthropic',
  baseUrl: 'https://api.anthropic.com',
  accounts: [],
  balancing: { strategy: 'round-robin' },
}

const minimalConfig = {
  backends: { primary: minimalBackend },
  routing: { default: { backend: 'primary' } },
}

describe('parseConfig', () => {
  it('parses a valid config', () => {
    const result = parseConfig(minimalConfig)
    expect(result.backends['primary']?.type).toBe('passthrough-anthropic')
    expect(result.routing.default.backend).toBe('primary')
  })

  it('applies defaults for optional fields', () => {
    const result = parseConfig(minimalConfig)
    expect(result.server.port).toBe(3000)
    expect(result.server.host).toBe('127.0.0.1')
    expect(result.auth.apiKeys).toEqual([])
    expect(result.telemetry.level).toBe('info')
    expect(result.routing.rules).toEqual([])
    expect(result.routing.scenarios).toEqual({})
  })

  it('preserves explicit server config', () => {
    const result = parseConfig({
      ...minimalConfig,
      server: { port: 8080, host: '0.0.0.0' },
    })
    expect(result.server.port).toBe(8080)
    expect(result.server.host).toBe('0.0.0.0')
  })

  it('rejects missing backends', () => {
    expect(() => parseConfig({ routing: { default: { backend: 'x' } } })).toThrow()
  })

  it('rejects missing routing.default', () => {
    expect(() => parseConfig({ backends: { primary: minimalBackend }, routing: {} })).toThrow()
  })

  it('rejects invalid backend type', () => {
    expect(() =>
      parseConfig({
        backends: { primary: { ...minimalBackend, type: 'unknown-type' } },
        routing: { default: { backend: 'primary' } },
      }),
    ).toThrow()
  })

  it('rejects invalid balancing strategy', () => {
    expect(() =>
      parseConfig({
        backends: {
          primary: { ...minimalBackend, balancing: { strategy: 'random' } },
        },
        routing: { default: { backend: 'primary' } },
      }),
    ).toThrow()
  })

  it('rejects routing default referencing unknown backend', () => {
    expect(() =>
      parseConfig({
        backends: { primary: minimalBackend },
        routing: { default: { backend: 'does-not-exist' } },
      }),
    ).toThrow(/Unknown backend "does-not-exist"/)
  })

  it('rejects routing rules referencing unknown backend', () => {
    expect(() =>
      parseConfig({
        backends: { primary: minimalBackend },
        routing: {
          default: { backend: 'primary' },
          rules: [{ match: 'claude-*', backend: 'ghost' }],
        },
      }),
    ).toThrow(/Unknown backend "ghost"/)
  })

  it('rejects scenario referencing unknown backend', () => {
    expect(() =>
      parseConfig({
        backends: { primary: minimalBackend },
        routing: {
          default: { backend: 'primary' },
          scenarios: { thinking: { backend: 'nowhere' } },
        },
      }),
    ).toThrow(/Unknown backend "nowhere"/)
  })

  it('accepts a full config with all optional fields', () => {
    const result = parseConfig({
      server: { port: 4000, host: 'localhost' },
      auth: { apiKeys: ['sk-abc'] },
      backends: {
        primary: minimalBackend,
        secondary: {
          type: 'passthrough-openai',
          baseUrl: 'https://api.openai.com',
          accounts: [{ type: 'api-key', name: 'main', key: 'sk-openai' }],
          balancing: { strategy: 'fill-first', rateLimitPerModel: true },
        },
      },
      routing: {
        default: { backend: 'primary' },
        rules: [{ match: 'gpt-*', backend: 'secondary' }],
        scenarios: {
          thinking: { backend: 'primary', model: 'claude-3-5-sonnet' },
          'long-context': { backend: 'secondary' },
        },
      },
      telemetry: { level: 'debug' },
    })
    expect(result.auth.apiKeys).toEqual(['sk-abc'])
    expect(result.routing.rules).toHaveLength(1)
    expect(result.telemetry.level).toBe('debug')
  })
})
