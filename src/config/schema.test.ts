import { describe, expect, test } from 'bun:test'
import { parseConfig } from './schema'

describe('parseConfig — providers', () => {
  test('parses a key-credential provider', () => {
    const opts = parseConfig({
      providers: {
        cerebras: { type: 'cerebras', account: { credential: 'key', key: 'sk-foo' } }
      }
    })
    expect(opts.providers.cerebras?.account).toEqual({ credential: 'key', key: 'sk-foo' })
  })
  test('parses an oauth-credential provider', () => {
    const opts = parseConfig({
      providers: {
        antigravity: {
          type: 'antigravity',
          account: { credential: 'oauth', name: 'user@gmail.com', projectId: 'p123' }
        }
      }
    })
    const a = opts.providers.antigravity?.account
    if (!a) throw new Error('antigravity provider missing')
    expect(a.credential).toBe('oauth')
    if (a.credential === 'oauth') expect(a.name).toBe('user@gmail.com')
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
        a: { type: 'openai-compatible', account: { credential: 'key', key: 'k' } },
        b: { type: 'openai-compatible', account: { credential: 'key', key: 'k' } }
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
        providers: { foo: { type: 'cerebras', account: { credential: 'key', key: 'k' } } },
        pipeline: { foo: 'bar' }
      })
    ).toThrow(/collision/i)
  })
})

describe('parseConfig — opencode option', () => {
  test('absent → undefined', () => {
    const opts = parseConfig({ providers: {} })
    expect(opts.opencode).toBeUndefined()
    expect('opencode' in opts).toBe(false)
  })
  test('false → undefined', () => {
    const opts = parseConfig({ providers: {}, opencode: false })
    expect(opts.opencode).toBeUndefined()
    expect('opencode' in opts).toBe(false)
  })
  test('true → empty object (enabled, host-derived url)', () => {
    const opts = parseConfig({ providers: {}, opencode: true })
    expect(opts.opencode).toEqual({})
  })
  test('empty object → empty object', () => {
    const opts = parseConfig({ providers: {}, opencode: {} })
    expect(opts.opencode).toEqual({})
  })
  test('object with api override', () => {
    const opts = parseConfig({ providers: {}, opencode: { api: 'https://x/v1' } })
    expect(opts.opencode).toEqual({ api: 'https://x/v1' })
  })
})
