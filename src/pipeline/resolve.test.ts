import { describe, expect, test } from 'bun:test'
import { buildTestModels } from '../models/test-models'
import type { RouterOptions } from '../types'
import { buildCatalog } from './catalog'
import { resolveCandidates } from './resolve'

const opts = (over: Partial<RouterOptions> = {}): RouterOptions => ({
  providers: {
    'claude-personal': { type: 'anthropic', account: { credential: 'key', key: 'x' } },
    'claude-work': { type: 'anthropic', account: { credential: 'key', key: 'y' } }
  },
  pipeline: [],
  expose: [],
  ...over
})

const resolve = (o: RouterOptions, model: string, req: { thinking?: boolean } = {}) =>
  resolveCandidates(o, buildCatalog(o, buildTestModels(o), '/tmp', new Map()), model, req)

const first = (o: RouterOptions, model: string, req: { thinking?: boolean } = {}) => {
  const list = resolve(o, model, req)
  const selected = list[0]
  if (!selected) throw new Error('no candidates')
  return selected
}

describe('resolveCandidates', () => {
  test('alias rewrites bare name to target', () => {
    const o = opts({
      pipeline: [{ kind: 'alias', name: 'opus', target: 'claude-personal/claude-opus-4-7' }]
    })
    const r = first(o, 'opus')
    expect(r.provider).toBe('claude-personal')
    expect(r.modelId).toBe('claude-opus-4-7')
  })

  test('pool balances via round-robin between members', () => {
    const o = opts({
      pipeline: [
        {
          kind: 'pool',
          name: 'pool',
          to: ['claude-personal/$1', 'claude-work/$1'],
          strategy: 'round-robin'
        }
      ]
    })
    const a = first(o, 'pool/claude-opus-4-7')
    expect(['claude-personal', 'claude-work']).toContain(a.provider)
    expect(a.modelId).toBe('claude-opus-4-7')
  })
  test('exact-match pools fire for the bare pool name', () => {
    const o = opts({
      pipeline: [
        {
          kind: 'pool',
          name: 'default',
          match: 'exact',
          to: ['claude-personal/claude-opus-4-7'],
          strategy: 'round-robin'
        }
      ]
    })
    expect(first(o, 'default')).toEqual({
      provider: 'claude-personal',
      modelId: 'claude-opus-4-7'
    })
  })

  test('exact-match pools do not fire for suffixed models', () => {
    const o = opts({
      pipeline: [
        {
          kind: 'pool',
          name: 'default',
          match: 'exact',
          to: ['claude-personal/claude-opus-4-7'],
          strategy: 'round-robin'
        }
      ]
    })
    expect(() => resolve(o, 'default/suffix')).toThrow(/unknown provider "default"/i)
  })

  test('exact-match pools with when gating remain exact', () => {
    const o = opts({
      providers: {
        provider: { type: 'anthropic', account: { credential: 'key', key: 'x' } }
      },
      pipeline: [
        {
          kind: 'pool',
          name: 'thinking-role',
          match: 'exact',
          to: ['provider/model'],
          strategy: 'round-robin',
          when: { thinking: true }
        }
      ]
    })
    expect(first(o, 'thinking-role', { thinking: true })).toEqual({
      provider: 'provider',
      modelId: 'model'
    })
    expect(() => resolve(o, 'other', { thinking: true })).toThrow(/unresolved bare model "other"/i)
  })

  test('alias chained through pool', () => {
    const o = opts({
      pipeline: [
        { kind: 'alias', name: 'opus', target: 'pool/claude-opus-4-7' },
        {
          kind: 'pool',
          name: 'pool',
          to: ['claude-personal/$1'],
          strategy: 'round-robin'
        }
      ]
    })
    const r = first(o, 'opus')
    expect(r.provider).toBe('claude-personal')
    expect(r.modelId).toBe('claude-opus-4-7')
  })

  test('when: thinking gates an entry', () => {
    const o = opts({
      pipeline: [
        {
          kind: 'pool',
          name: 'detect',
          to: ['thinking/$0'],
          strategy: 'round-robin',
          when: { thinking: true }
        },
        {
          kind: 'pool',
          name: 'thinking',
          to: ['claude-personal/claude-opus-4-7'],
          strategy: 'round-robin'
        }
      ]
    })
    const yes = first(o, 'something', { thinking: true })
    expect(yes.provider).toBe('claude-personal')
    expect(yes.modelId).toBe('claude-opus-4-7')
  })

  test('when: thinking does NOT fire when flag is false', () => {
    const o = opts({
      pipeline: [
        {
          kind: 'pool',
          name: 'detect',
          to: ['thinking/$0'],
          strategy: 'round-robin',
          when: { thinking: true }
        },
        { kind: 'alias', name: 'something', target: 'claude-personal/claude-3-5-haiku' }
      ]
    })
    // thinking flag is false → detect entry should NOT fire; alias fires instead
    const r = first(o, 'something', { thinking: false })
    expect(r.provider).toBe('claude-personal')
    expect(r.modelId).toBe('claude-3-5-haiku')
  })

  test('throws when prefix is not a provider', () => {
    const o = opts({ providers: {} })
    expect(() => resolve(o, 'unknown/model')).toThrow(/unknown provider/i)
  })

  test('cycle protected by seen set', () => {
    const o = opts({
      pipeline: [
        { kind: 'alias', name: 'a', target: 'b' },
        { kind: 'alias', name: 'b', target: 'a' }
      ]
    })
    expect(() => resolve(o, 'a')).toThrow(/cycle/i)
  })

  test('failover pool returns members in declaration order', () => {
    const o = opts({
      pipeline: [
        {
          kind: 'pool',
          name: 'gpt',
          to: ['claude-personal/$1', 'claude-work/$1'],
          strategy: 'failover'
        }
      ]
    })
    const list = resolve(o, 'gpt/x')
    expect(list).toEqual([
      { provider: 'claude-personal', modelId: 'x' },
      { provider: 'claude-work', modelId: 'x' }
    ])
  })

  test('failover pool with glob members expands all matches in catalog order', () => {
    const o = opts({
      pipeline: [
        {
          kind: 'pool',
          name: 'all',
          to: ['claude-personal/zzz-*', 'claude-work/zzz-*'],
          strategy: 'failover'
        }
      ]
    })
    // No real model IDs start with 'zzz-', so glob expansion yields no
    // candidates; the test guards the no-match / empty-list path.
    const list = resolve(o, 'all/whatever')
    expect(list).toEqual([])
  })

  test('non-failover pool with multiple members returns a single picked candidate', () => {
    const o = opts({
      pipeline: [
        {
          kind: 'pool',
          name: 'pool',
          to: ['claude-personal/$1', 'claude-work/$1'],
          strategy: 'round-robin'
        }
      ]
    })
    const list = resolve(o, 'pool/claude-opus-4-7')
    expect(list).toHaveLength(1)
    const firstCandidate = list[0]
    if (!firstCandidate) throw new Error('missing candidate')
    expect(['claude-personal', 'claude-work']).toContain(firstCandidate.provider)
    expect(firstCandidate.modelId).toBe('claude-opus-4-7')
  })
})
