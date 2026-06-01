import { describe, expect, it } from 'bun:test'

import { parseConfig } from './schema'

const minimalProvider = { type: 'anthropic', accounts: [], balancing: { strategy: 'round-robin' } }

const minimalConfig = {
  providers: { primary: minimalProvider },
  routing: { default: { provider: 'primary' } }
}

describe('parseConfig', () => {
  it('parses a valid config', () => {
    const result = parseConfig(minimalConfig)
    expect(result.providers.primary?.type).toBe('anthropic')
    expect(result.routing.default.provider).toBe('primary')
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

  it('applies default authDir', () => {
    const result = parseConfig(minimalConfig)
    expect(result.authDir).toBe('~/.config/hono-router/auth')
  })

  it('accepts a custom authDir', () => {
    const result = parseConfig({ ...minimalConfig, authDir: '/custom/auth' })
    expect(result.authDir).toBe('/custom/auth')
  })

  it('resolves baseUrl for anthropic when not specified', () => {
    const result = parseConfig(minimalConfig)
    expect(result.providers.primary?.baseUrl).toBe('https://api.anthropic.com')
  })

  it('resolves baseUrl for antigravity when not specified', () => {
    const result = parseConfig({
      providers: {
        ag: { type: 'antigravity', accounts: [], balancing: { strategy: 'round-robin' } }
      },
      routing: { default: { provider: 'ag' } }
    })
    expect(result.providers.ag?.baseUrl).toBe('https://daily-cloudcode-pa.googleapis.com')
  })

  it('preserves explicit baseUrl over default', () => {
    const result = parseConfig({
      providers: { primary: { ...minimalProvider, baseUrl: 'https://custom.example.com' } },
      routing: { default: { provider: 'primary' } }
    })
    expect(result.providers.primary?.baseUrl).toBe('https://custom.example.com')
  })

  it('preserves explicit server config', () => {
    const result = parseConfig({ ...minimalConfig, server: { port: 8080, host: '0.0.0.0' } })
    expect(result.server.port).toBe(8080)
    expect(result.server.host).toBe('0.0.0.0')
  })

  it('rejects missing providers', () => {
    expect(() => parseConfig({ routing: { default: { provider: 'x' } } })).toThrow()
  })

  it('rejects missing routing.default', () => {
    expect(() => parseConfig({ providers: { primary: minimalProvider }, routing: {} })).toThrow()
  })

  it('rejects invalid provider type', () => {
    expect(() =>
      parseConfig({
        providers: { primary: { ...minimalProvider, type: 'unknown-type' } },
        routing: { default: { provider: 'primary' } }
      })
    ).toThrow()
  })

  it('rejects invalid balancing strategy', () => {
    expect(() =>
      parseConfig({
        providers: { primary: { ...minimalProvider, balancing: { strategy: 'random' } } },
        routing: { default: { provider: 'primary' } }
      })
    ).toThrow()
  })

  it('rejects routing default referencing unknown provider', () => {
    expect(() =>
      parseConfig({
        providers: { primary: minimalProvider },
        routing: { default: { provider: 'does-not-exist' } }
      })
    ).toThrow(/Unknown provider "does-not-exist"/)
  })

  it('rejects routing rules referencing unknown provider', () => {
    expect(() =>
      parseConfig({
        providers: { primary: minimalProvider },
        routing: {
          default: { provider: 'primary' },
          rules: [{ match: 'claude-*', provider: 'ghost' }]
        }
      })
    ).toThrow(/Unknown provider "ghost"/)
  })

  it('rejects scenario referencing unknown provider', () => {
    expect(() =>
      parseConfig({
        providers: { primary: minimalProvider },
        routing: {
          default: { provider: 'primary' },
          scenarios: { thinking: { provider: 'nowhere' } }
        }
      })
    ).toThrow(/Unknown provider "nowhere"/)
  })

  it('accepts a full config with all optional fields', () => {
    const result = parseConfig({
      server: { port: 4000, host: 'localhost' },
      auth: { apiKeys: ['sk-abc'] },
      providers: {
        primary: minimalProvider,
        secondary: {
          type: 'openai',
          baseUrl: 'https://api.openai.com',
          accounts: [{ type: 'api-key', name: 'main', key: 'sk-main' }],
          balancing: { strategy: 'fill-first', rateLimitPerModel: true }
        }
      },
      routing: {
        default: { provider: 'primary' },
        rules: [{ match: 'gpt-*', provider: 'secondary' }],
        scenarios: {
          thinking: { provider: 'primary', model: 'claude-3-5-sonnet' },
          'long-context': { provider: 'secondary' }
        }
      },
      telemetry: { level: 'debug' }
    })
    expect(result.auth.apiKeys).toEqual(['sk-abc'])
    expect(result.routing.rules).toHaveLength(1)
    expect(result.telemetry.level).toBe('debug')
  })
})
