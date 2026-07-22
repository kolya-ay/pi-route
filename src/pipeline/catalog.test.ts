import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTestModels } from '../models/test-models'
import type { RouterOptions } from '../types'
import { buildCatalog } from './catalog'

const baseOpts = (over: Partial<RouterOptions> = {}): RouterOptions => ({
  providers: {},
  pipeline: [],
  expose: [],
  ...over
})

// A state dir where every oauth account in `o` has a credential file — i.e.
// "everything is logged in", so availability filtering is a no-op.
const loggedInDir = (o: RouterOptions): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cat-'))
  for (const p of Object.values(o.providers)) {
    if (p.account.credential === 'oauth') writeFileSync(join(dir, `${p.account.name}.json`), '{}')
  }
  return dir
}

// Build the catalog against a real Models over the same options.
const build = (o: RouterOptions) => buildCatalog(o, buildTestModels(o), loggedInDir(o), new Map())

describe('buildCatalog', () => {
  test('adds catalog addresses for known provider types', () => {
    const c = build(
      baseOpts({
        providers: {
          cerebras: { type: 'cerebras', account: { credential: 'key', key: 'k' } }
        }
      })
    )
    expect([...c.addresses].some((a) => a.startsWith('cerebras/'))).toBe(true)
  })

  test('anthropic provider surfaces cc/claude-opus-4-8', () => {
    const c = build(
      baseOpts({
        providers: {
          cc: { type: 'anthropic', account: { credential: 'oauth', name: 'anthropic-cc' } }
        }
      })
    )
    expect(c.addresses.has('cc/claude-opus-4-8')).toBe(true)
  })

  test('adds literal pipeline targets without globs', () => {
    const c = build(
      baseOpts({
        providers: {
          chutes: {
            type: 'openai-compatible',
            baseUrl: 'https://llm.chutes.ai/v1',
            account: { credential: 'key', key: 'k' }
          }
        },
        pipeline: [{ kind: 'alias', name: 'opus', target: 'chutes/zai-org/GLM-5.1-TEE' }]
      })
    )
    expect(c.addresses.has('chutes/zai-org/GLM-5.1-TEE')).toBe(true)
  })

  test('alias names are addressable and leafFor resolves one hop', () => {
    const c = build(
      baseOpts({
        providers: { p: { type: 'cerebras', account: { credential: 'key', key: 'k' } } },
        pipeline: [{ kind: 'alias', name: 'opus', target: 'p/some-specific-model' }]
      })
    )
    expect(c.addresses.has('opus')).toBe(true)
    // Even if `p/some-specific-model` isn't a known pi-ai model,
    // the literal target was added in step 2, so leafFor['opus'] resolves to it.
    expect(c.leafFor.get('opus')).toBe('p/some-specific-model')
  })

  test('pool prefix addresses are addressable', () => {
    const c = build(
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
    const c = build(
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
    const c = build(
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
})

describe('availability filtering', () => {
  test('omits an oauth provider with no credential file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cat-'))
    const o: RouterOptions = {
      providers: {
        cc: { type: 'anthropic', account: { credential: 'oauth', name: 'anthropic-cc' } }
      },
      pipeline: [],
      expose: []
    }
    const models = buildTestModels(o)
    expect([...buildCatalog(o, models, dir, new Map()).addresses]).toEqual([])
    writeFileSync(join(dir, 'anthropic-cc.json'), '{}')
    expect([...buildCatalog(o, models, dir, new Map()).addresses].length).toBeGreaterThan(0)
  })

  test('drops literal pipeline targets of unavailable providers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cat-'))
    const o: RouterOptions = {
      providers: {
        cc: { type: 'anthropic', account: { credential: 'oauth', name: 'anthropic-cc' } }
      },
      pipeline: [{ kind: 'alias', name: 'slow', target: 'cc/claude-opus-4-8' }],
      expose: []
    }
    const catalog = buildCatalog(o, buildTestModels(o), dir, new Map())
    expect(catalog.addresses.has('cc/claude-opus-4-8')).toBe(false)
    expect(catalog.addresses.has('slow')).toBe(false)
  })

  test('drops targets naming a provider that is not configured at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cat-'))
    const o: RouterOptions = {
      providers: {},
      pipeline: [{ kind: 'alias', name: 'slow', target: 'ag/gemini-3.1-pro' }],
      expose: []
    }
    const catalog = buildCatalog(o, buildTestModels(o), dir, new Map())
    expect(catalog.addresses.has('ag/gemini-3.1-pro')).toBe(false)
    expect(catalog.addresses.has('slow')).toBe(false)
  })

  test('a pool keeps its available members and loses the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cat-'))
    writeFileSync(join(dir, 'anthropic-cc.json'), '{}')
    const o: RouterOptions = {
      providers: {
        cc: { type: 'anthropic', account: { credential: 'oauth', name: 'anthropic-cc' } },
        gone: { type: 'anthropic', account: { credential: 'oauth', name: 'anthropic-gone' } }
      },
      pipeline: [
        {
          kind: 'pool',
          name: 'default',
          match: 'exact',
          to: ['gone/claude-opus-4-8', 'cc/claude-opus-4-8'],
          strategy: 'failover'
        }
      ],
      expose: []
    }
    const catalog = buildCatalog(o, buildTestModels(o), dir, new Map())
    expect(catalog.addresses.has('default')).toBe(true)
    expect(catalog.leafFor.get('default')).toBe('cc/claude-opus-4-8')
    expect(catalog.addresses.has('gone/claude-opus-4-8')).toBe(false)
  })

  test('an alias onto a pool of unavailable providers is dropped too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cat-'))
    const o: RouterOptions = {
      providers: {
        cc: { type: 'anthropic', account: { credential: 'oauth', name: 'anthropic-cc' } }
      },
      pipeline: [
        {
          kind: 'pool',
          name: 'workhorse',
          match: 'exact',
          to: ['cc/claude-opus-4-8'],
          strategy: 'failover'
        },
        { kind: 'alias', name: 'big', target: 'workhorse' }
      ],
      expose: []
    }
    expect([...buildCatalog(o, buildTestModels(o), dir, new Map()).addresses]).toEqual([])
    // Control: the same chain is fully addressable once cc has a credential.
    writeFileSync(join(dir, 'anthropic-cc.json'), '{}')
    const live = buildCatalog(o, buildTestModels(o), dir, new Map())
    expect(live.addresses.has('workhorse')).toBe(true)
    expect(live.addresses.has('big')).toBe(true)
  })

  test('a reference cycle between two aliases is not usable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cat-'))
    const o: RouterOptions = {
      providers: {},
      pipeline: [
        { kind: 'alias', name: 'a', target: 'b' },
        { kind: 'alias', name: 'b', target: 'a' }
      ],
      expose: []
    }
    const catalog = buildCatalog(o, buildTestModels(o), dir, new Map())
    expect([...catalog.addresses]).toEqual([])
  })

  test('a pool whose members are all unavailable is not registered', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cat-'))
    const o: RouterOptions = {
      providers: {
        cc: { type: 'anthropic', account: { credential: 'oauth', name: 'anthropic-cc' } },
        gone: { type: 'anthropic', account: { credential: 'oauth', name: 'anthropic-gone' } }
      },
      pipeline: [
        {
          kind: 'pool',
          name: 'default',
          match: 'exact',
          to: ['cc/claude-opus-4-8', 'gone/claude-opus-4-8'],
          strategy: 'failover'
        }
      ],
      expose: []
    }
    const catalog = buildCatalog(o, buildTestModels(o), dir, new Map())
    expect(catalog.addresses.has('default')).toBe(false)
  })
})
