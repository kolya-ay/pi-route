import { describe, expect, test } from 'bun:test'
import { parseConfig } from './schema'

describe('parseConfig — providers', () => {
  test('apiKey desugars to internal key-credential account', () => {
    const opts = parseConfig({
      providers: { cerebras: { type: 'cerebras', apiKey: 'sk-foo' } }
    })
    expect(opts.providers.cerebras?.account).toEqual({ credential: 'key', key: 'sk-foo' })
  })

  test('account string desugars to oauth account keyed <type>-<account>', () => {
    const opts = parseConfig({
      providers: { anthropic: { type: 'anthropic', account: 'main' } }
    })
    expect(opts.providers.anthropic?.account).toEqual({
      credential: 'oauth',
      name: 'anthropic-main'
    })
  })

  test('account object carries projectId; name keyed <type>-<account>', () => {
    const opts = parseConfig({
      providers: {
        ag: { type: 'antigravity', account: { name: 'user@gmail.com', projectId: 'p123' } }
      }
    })
    expect(opts.providers.ag?.account).toEqual({
      credential: 'oauth',
      name: 'antigravity-user@gmail.com',
      projectId: 'p123'
    })
  })

  test('provider-level disabled desugars onto the account', () => {
    const opts = parseConfig({
      providers: { cerebras: { type: 'cerebras', apiKey: 'sk-foo', disabled: true } }
    })
    expect(opts.providers.cerebras?.account).toEqual({
      credential: 'key',
      key: 'sk-foo',
      disabled: true
    })
  })

  test('rejects a provider with both apiKey and account', () => {
    expect(() =>
      parseConfig({ providers: { x: { type: 'openai-compatible', apiKey: 'k', account: 'y' } } })
    ).toThrow()
  })

  test('rejects a provider with neither apiKey nor account', () => {
    expect(() => parseConfig({ providers: { x: { type: 'openai-compatible' } } })).toThrow()
  })

  test('rejects oauth on an openai-compatible provider', () => {
    expect(() =>
      parseConfig({
        providers: { x: { type: 'openai-compatible', baseUrl: 'https://e/v1', account: 'main' } }
      })
    ).toThrow(/oauth/i)
  })

  test('still accepts an apiKey openai-compatible provider', () => {
    const opts = parseConfig({
      providers: { x: { type: 'openai-compatible', baseUrl: 'https://e/v1', apiKey: 'sk' } }
    })
    expect(opts.providers.x?.account).toEqual({ credential: 'key', key: 'sk' })
  })

  test('still accepts oauth on a non-openai type (antigravity)', () => {
    const opts = parseConfig({ providers: { ag: { type: 'antigravity', account: 'u@e.com' } } })
    expect(opts.providers.ag?.account.credential).toBe('oauth')
  })
})

describe('parseConfig — pipeline value shapes', () => {
  test('string value parses as alias', () => {
    const opts = parseConfig({
      providers: {},
      pipeline: { opus: 'claude-pool/claude-opus-4-7' }
    })
    expect(opts.pipeline).toEqual([
      { kind: 'alias', name: 'opus', target: 'claude-pool/claude-opus-4-7' }
    ])
  })
  test('list value parses as pool with default strategy', () => {
    const opts = parseConfig({
      providers: {},
      pipeline: { 'claude-pool': ['claude-personal/$1', 'claude-work/$1'] }
    })
    expect(opts.pipeline).toEqual([
      {
        kind: 'pool',
        name: 'claude-pool',
        to: ['claude-personal/$1', 'claude-work/$1'],
        strategy: 'round-robin'
      }
    ])
  })
  test('object value carries strategy and when', () => {
    const opts = parseConfig({
      providers: {},
      pipeline: {
        sticky: { to: ['a/$1', 'b/$1'], strategy: 'sticky' },
        detect: { to: 'thinking/$0', when: { thinking: true } }
      }
    })
    expect(opts.pipeline).toEqual([
      {
        kind: 'pool',
        name: 'sticky',
        to: ['a/$1', 'b/$1'],
        strategy: 'sticky'
      },
      {
        kind: 'pool',
        name: 'detect',
        to: ['thinking/$0'],
        strategy: 'round-robin',
        when: { thinking: true }
      }
    ])
  })
  test('object value parses exact-match pools and normalizes to arrays', () => {
    const opts = parseConfig({
      providers: {},
      pipeline: {
        default: { match: 'exact', to: ['p/a', 'p/b'], strategy: 'fill-first' },
        small: { match: 'exact', to: 'p/small' }
      }
    })
    expect(opts.pipeline).toEqual([
      {
        kind: 'pool',
        name: 'default',
        match: 'exact',
        to: ['p/a', 'p/b'],
        strategy: 'fill-first'
      },
      {
        kind: 'pool',
        name: 'small',
        match: 'exact',
        to: ['p/small'],
        strategy: 'round-robin'
      }
    ])
  })
  test('rejects an invalid match value on a pipeline object entry', () => {
    expect(() =>
      parseConfig({
        providers: {},
        pipeline: {
          small: { match: 'bogus', to: 'p/small' }
        }
      })
    ).toThrow()
  })
  test('preserves YAML insertion order', () => {
    const opts = parseConfig({
      providers: {},
      pipeline: { a: 'x', b: 'y', c: 'z' }
    })
    expect(opts.pipeline.map((e) => e.name)).toEqual(['a', 'b', 'c'])
  })
  test('accepts strategy: failover on a pool entry', () => {
    const parsed = parseConfig({
      providers: {
        a: { type: 'openai-compatible', apiKey: 'k' },
        b: { type: 'openai-compatible', apiKey: 'k' }
      },
      pipeline: {
        gpt: { to: ['a/x', 'b/x'], strategy: 'failover' }
      }
    })
    expect(parsed.pipeline).toHaveLength(1)
    const entry = parsed.pipeline[0]
    if (!entry) throw new Error('pipeline entry missing')
    expect(entry.kind).toBe('pool')
    if (entry.kind !== 'pool') throw new Error('unreachable')
    expect(entry.strategy).toBe('failover')
    expect(entry.to).toEqual(['a/x', 'b/x'])
  })
})

describe('parseConfig — expose', () => {
  test('defaults to empty (means all reachable)', () => {
    const opts = parseConfig({ providers: {} })
    expect(opts.expose).toEqual([])
  })
  test('accepts list of glob strings', () => {
    const opts = parseConfig({ providers: {}, expose: ['claude-pool/**', '!chutes/**'] })
    expect(opts.expose).toEqual(['claude-pool/**', '!chutes/**'])
  })
})

describe('parseConfig — collision', () => {
  test('errors when pipeline entry name collides with provider name', () => {
    expect(() =>
      parseConfig({
        providers: { foo: { type: 'cerebras', apiKey: 'k' } },
        pipeline: { foo: 'bar' }
      })
    ).toThrow(/collision/i)
  })
})

describe('provider discover + modelOverrides', () => {
  test('parses discover chain and modelOverrides map', () => {
    const opts = parseConfig({
      providers: {
        chutes: {
          type: 'openai-compatible',
          baseUrl: 'https://llm.chutes.ai/v1',
          apiKey: 'x',
          discover: ['auto'],
          modelOverrides: { 'MiniMaxAI/MiniMax-M2.5-TEE': { contextWindow: 204800 } }
        }
      }
    })
    expect(opts.providers.chutes!.discover).toEqual(['auto'])
    expect(opts.providers.chutes!.modelOverrides!['MiniMaxAI/MiniMax-M2.5-TEE']).toEqual({
      contextWindow: 204800
    })
  })

  test('discover: false parses through as an opt-out', () => {
    const opts = parseConfig({
      providers: {
        chutes: {
          type: 'openai-compatible',
          baseUrl: 'https://llm.chutes.ai/v1',
          apiKey: 'x',
          discover: false
        }
      }
    })
    expect(opts.providers.chutes!.discover).toBe(false)
  })

  test('rejects an unknown discover strategy', () => {
    expect(() =>
      parseConfig({
        providers: {
          p: {
            type: 'openai-compatible',
            apiKey: 'x',
            discover: ['nope']
          }
        }
      })
    ).toThrow()
  })
})

describe('parseConfig — server section', () => {
  test('parses a server section with authToken and opencode', () => {
    const opts = parseConfig({
      providers: {},
      pipeline: {},
      server: { authToken: 'sk-gate', opencode: true }
    })
    expect(opts.server?.authToken).toBe('sk-gate')
    expect(opts.server?.opencode).toEqual({})
  })
  test('server.opencode object keeps its api override', () => {
    const opts = parseConfig({
      providers: {},
      pipeline: {},
      server: { opencode: { api: 'https://host/v1' } }
    })
    expect(opts.server?.opencode).toEqual({ api: 'https://host/v1' })
  })
  test('a top-level opencode key is rejected, not silently dropped', () => {
    expect(() => parseConfig({ providers: {}, pipeline: {}, opencode: true })).toThrow()
  })
  test('server.opencode false desugars to undefined', () => {
    const opts = parseConfig({ providers: {}, pipeline: {}, server: { opencode: false } })
    expect(opts.server?.opencode).toBeUndefined()
  })
})

describe('discover defaults', () => {
  test('openai-compatible without discover defaults to auto', () => {
    const o = parseConfig({
      providers: { chutes: { type: 'openai-compatible', baseUrl: 'https://x/v1', apiKey: 'k' } }
    })
    expect(o.providers.chutes?.discover).toEqual(['auto'])
  })

  test('an explicit chain is preserved', () => {
    const o = parseConfig({
      providers: {
        nvidia: {
          type: 'openai-compatible',
          baseUrl: 'https://x/v1',
          apiKey: 'k',
          discover: ['guess']
        }
      }
    })
    expect(o.providers.nvidia?.discover).toEqual(['guess'])
  })

  test('discover: false stays an opt-out', () => {
    const o = parseConfig({
      providers: {
        x: { type: 'openai-compatible', baseUrl: 'https://x/v1', apiKey: 'k', discover: false }
      }
    })
    expect(o.providers.x?.discover).toBe(false)
  })

  test('other provider types get no default', () => {
    const o = parseConfig({ providers: { cc: { type: 'anthropic', account: 'cc' } } })
    expect(o.providers.cc?.discover).toBeUndefined()
  })
})

describe('strictness', () => {
  test('an unknown provider key is rejected', () => {
    expect(() =>
      parseConfig({
        providers: { x: { type: 'openai-compatible', basUrl: 'https://x', apiKey: 'k' } }
      })
    ).toThrow()
  })

  test('an unknown root key is rejected', () => {
    expect(() => parseConfig({ providers: {}, expse: [] })).toThrow()
  })

  test('a pipeline entry named expose is rejected with a hint', () => {
    expect(() => parseConfig({ providers: {}, pipeline: { expose: ['cc/*'] } })).toThrow(
      /reserved top-level key/
    )
  })

  // Only the tracked config: router.local.yaml is gitignored (live keys), so
  // reading it here would ENOENT on a clean checkout.
  test('the shipped example config still parses', async () => {
    const raw = Bun.YAML.parse(await Bun.file('router.example.yaml').text())
    expect(() => parseConfig(raw)).not.toThrow()
  })
})
