import { describe, expect, test } from 'bun:test'
import type { RouterOptions } from '../types'
import { buildCatalog } from './catalog'

const baseOpts = (over: Partial<RouterOptions> = {}): RouterOptions => ({
  providers: {},
  pipeline: [],
  expose: [],
  ...over
})

describe('buildCatalog', () => {
  test('adds pi-ai catalog addresses for known provider types', () => {
    const c = buildCatalog(
      baseOpts({
        providers: {
          cerebras: { type: 'cerebras', account: { credential: 'key', key: 'k' } }
        }
      })
    )
    expect([...c.addresses].some((a) => a.startsWith('cerebras/'))).toBe(true)
  })

  test('adds literal pipeline targets without globs', () => {
    const c = buildCatalog(
      baseOpts({
        providers: {
          chutes: { type: 'openai-compatible', account: { credential: 'key', key: 'k' } }
        },
        pipeline: [{ kind: 'alias', name: 'opus', target: 'chutes/zai-org/GLM-5.1-TEE' }]
      })
    )
    expect(c.addresses.has('chutes/zai-org/GLM-5.1-TEE')).toBe(true)
  })

  test('alias names are addressable', () => {
    const c = buildCatalog(
      baseOpts({
        pipeline: [{ kind: 'alias', name: 'opus', target: 'foo/bar' }]
      })
    )
    expect(c.addresses.has('opus')).toBe(true)
  })

  test('pool prefix addresses are addressable', () => {
    const c = buildCatalog(
      baseOpts({
        providers: { p: { type: 'cerebras', account: { credential: 'key', key: 'k' } } },
        pipeline: [
          {
            kind: 'pool',
            name: 'pool',
            to: ['p/$1'],
            strategy: 'round-robin'
          }
        ]
      })
    )
    const piModels = [...c.addresses].filter((a) => a.startsWith('p/'))
    expect(piModels.length).toBeGreaterThan(0)
    for (const a of piModels) {
      const tail = a.slice(2)
      const poolAddr = `pool/${tail}`
      expect(c.addresses.has(poolAddr)).toBe(true)
      expect(c.leafFor.get(poolAddr)).toBe(a)
    }
  })
  test('exact-match pools do not derive prefix addresses', () => {
    const c = buildCatalog(
      baseOpts({
        providers: { p: { type: 'cerebras', account: { credential: 'key', key: 'k' } } },
        pipeline: [
          {
            kind: 'pool',
            name: 'pool',
            match: 'exact',
            to: ['p/$1'],
            strategy: 'round-robin'
          }
        ]
      })
    )
    const piModels = [...c.addresses].filter((a) => a.startsWith('p/'))
    expect(piModels.length).toBeGreaterThan(0)
    for (const a of piModels) {
      const tail = a.slice(2)
      const poolAddr = `pool/${tail}`
      expect(c.addresses.has(poolAddr)).toBe(false)
      expect(c.leafFor.has(poolAddr)).toBe(false)
    }
  })

  test('exact-match default pool targeting a provider leaf is only addressable by bare default', () => {
    const c = buildCatalog(
      baseOpts({
        providers: { p: { type: 'cerebras', account: { credential: 'key', key: 'k' } } },
        pipeline: [
          {
            kind: 'pool',
            name: 'default',
            match: 'exact',
            to: ['p/some-specific-model'],
            strategy: 'round-robin'
          }
        ]
      })
    )
    expect(c.addresses.has('default')).toBe(true)
    expect(c.addresses.has('default/some-specific-model')).toBe(false)
  })

  test('alias leafFor resolves one hop', () => {
    const c = buildCatalog(
      baseOpts({
        providers: { p: { type: 'cerebras', account: { credential: 'key', key: 'k' } } },
        pipeline: [{ kind: 'alias', name: 'opus', target: 'p/some-specific-model' }]
      })
    )
    // Even if `p/some-specific-model` isn't a known pi-ai model,
    // the literal target was added in step 2, so leafFor['opus'] resolves to it.
    expect(c.leafFor.get('opus')).toBe('p/some-specific-model')
  })
})
