import { describe, expect, test } from 'bun:test'
import type { RouterOptions } from '../types'
import { buildCatalog } from './catalog'
import { resolveModel } from './resolve'

const opts = (over: Partial<RouterOptions> = {}): RouterOptions => ({
  providers: {
    'claude-personal': { type: 'anthropic', account: { credential: 'file', path: '/x' } },
    'claude-work': { type: 'anthropic', account: { credential: 'file', path: '/y' } }
  },
  pipeline: [],
  expose: [],
  ...over
})

const resolve = (o: RouterOptions, model: string, req: { thinking?: boolean } = {}) =>
  resolveModel(o, buildCatalog(o), model, req)

describe('resolveModel', () => {
  test('alias rewrites bare name to target', () => {
    const o = opts({
      pipeline: [{ kind: 'alias', name: 'opus', target: 'claude-personal/claude-opus-4-7' }]
    })
    const r = resolve(o, 'opus')
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
    const a = resolve(o, 'pool/claude-opus-4-7')
    expect(['claude-personal', 'claude-work']).toContain(a.provider)
    expect(a.modelId).toBe('claude-opus-4-7')
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
    const r = resolve(o, 'opus')
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
    const yes = resolve(o, 'something', { thinking: true })
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
    const r = resolve(o, 'something', { thinking: false })
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
})
