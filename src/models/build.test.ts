import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RouterOptions } from '../types'
import { buildModels } from './build'

const dirs = () => mkdtempSync(join(tmpdir(), 'pi-route-build-'))

const options = {
  providers: {
    cc: { type: 'anthropic', account: { credential: 'oauth', name: 'cc' } },
    codex: { type: 'openai-codex', account: { credential: 'oauth', name: 'codex' } },
    ag: { type: 'antigravity', account: { credential: 'oauth', name: 'antigravity' } },
    chutes: {
      type: 'openai-compatible',
      baseUrl: 'https://llm.chutes.ai/v1',
      account: { credential: 'key', key: 'k' }
    }
  },
  pipeline: [],
  expose: []
} as unknown as RouterOptions

describe('buildModels', () => {
  test('one provider per config entry, id = config name', () => {
    const models = buildModels(options, { stateDir: dirs(), authDir: dirs() })
    expect(
      models
        .getProviders()
        .map((p) => p.id)
        .sort()
    ).toEqual(['ag', 'cc', 'chutes', 'codex'])
  })

  test('static catalogs are re-stamped with config ids', () => {
    const models = buildModels(options, { stateDir: dirs(), authDir: dirs() })
    const cc = models.getModels('cc')
    expect(cc.length).toBeGreaterThan(0)
    expect(cc.every((m) => m.provider === 'cc')).toBe(true)
    expect(cc.some((m) => m.id === 'claude-opus-4-8')).toBe(true)
    expect(models.getModels('codex').some((m) => m.id.startsWith('gpt-5.6'))).toBe(true)
  })

  test('openai-compatible providers get baseUrl-stamped empty catalogs', () => {
    const models = buildModels(options, { stateDir: dirs(), authDir: dirs() })
    expect(models.getProvider('chutes')?.baseUrl).toBe('https://llm.chutes.ai/v1')
    expect(models.getModels('chutes')).toEqual([])
  })

  test('openai-compatible providers get an endpoint catalog unless discover is false', () => {
    const withDiscoverOptions = {
      providers: {
        nvidia: {
          type: 'openai-compatible',
          baseUrl: 'https://example.test/v1',
          discover: ['guess'],
          account: { credential: 'key', name: 'nvidia', key: 'k' }
        },
        quiet: {
          type: 'openai-compatible',
          baseUrl: 'https://quiet.test/v1',
          discover: false,
          account: { credential: 'key', name: 'quiet', key: 'k' }
        }
      },
      pipeline: [],
      expose: []
    } as unknown as RouterOptions

    const models = buildModels(withDiscoverOptions, { stateDir: dirs(), authDir: dirs() })

    expect(models.getProvider('nvidia')?.refreshModels).toBeDefined()
    expect(models.getProvider('quiet')?.refreshModels).toBeUndefined()
  })

  test('a disabled account never gets an endpoint catalog, even with a baseUrl', () => {
    const disabledOptions = {
      providers: {
        nvidia: {
          type: 'openai-compatible',
          baseUrl: 'https://example.test/v1',
          account: { credential: 'key', name: 'nvidia', key: 'k', disabled: true }
        }
      },
      pipeline: [],
      expose: []
    } as unknown as RouterOptions

    const models = buildModels(disabledOptions, { stateDir: dirs(), authDir: dirs() })

    expect(models.getProvider('nvidia')?.refreshModels).toBeUndefined()
  })

  test('records endpoint-catalog providers into the wrapped sink', () => {
    const wrapped = new Set<string>()
    const dir = dirs()
    buildModels(
      {
        providers: {
          ep: {
            type: 'openai-compatible',
            baseUrl: 'https://e/v1',
            account: { credential: 'key', key: 'k' },
            discover: ['auto']
          },
          off: {
            type: 'openai-compatible',
            baseUrl: 'https://e/v1',
            account: { credential: 'key', key: 'k', disabled: true },
            discover: ['auto']
          }
        },
        pipeline: [],
        expose: []
      } as unknown as RouterOptions,
      { stateDir: dir, authDir: dir, wrapped }
    )
    expect(wrapped.has('ep')).toBe(true)
    expect(wrapped.has('off')).toBe(false) // disabled → no endpoint catalog → not covered
  })

  const withAg = (disabled?: boolean) =>
    ({
      ...options,
      providers: {
        ag: {
          type: 'antigravity',
          account: {
            credential: 'oauth',
            name: 'antigravity',
            ...(disabled === undefined ? {} : { disabled })
          }
        }
      }
    }) as unknown as RouterOptions

  test('a disabled provider loses refreshModels', () => {
    const models = buildModels(withAg(true), { stateDir: dirs(), authDir: dirs() })
    const provider = models.getProviders().find((p) => p.id === 'ag')
    expect(provider).toBeDefined()
    expect(provider?.refreshModels).toBeUndefined()
  })

  test('an enabled provider keeps refreshModels', () => {
    const models = buildModels(withAg(), { stateDir: dirs(), authDir: dirs() })
    expect(models.getProviders().find((p) => p.id === 'ag')?.refreshModels).toBeDefined()
  })

  test('a disabled FACTORIES provider is still wrapped and can still restore', () => {
    const withCc = {
      ...options,
      providers: {
        cc: { type: 'anthropic', account: { credential: 'oauth', name: 'cc', disabled: true } }
      }
    } as unknown as RouterOptions
    const models = buildModels(withCc, { stateDir: dirs(), authDir: dirs() })
    expect(models.getProviders().find((p) => p.id === 'cc')?.refreshModels).toBeDefined()
  })

  test('antigravity keeps its own discovery instead of the endpoint catalog when config sets a baseUrl', async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    try {
      const antigravityOptions = {
        providers: {
          ag: {
            type: 'antigravity',
            baseUrl: 'https://not-antigravity.test/v1',
            account: { credential: 'oauth', name: 'antigravity' }
          }
        },
        pipeline: [],
        expose: []
      } as unknown as RouterOptions

      const models = buildModels(antigravityOptions, { stateDir: dirs(), authDir: dirs() })
      // No oauth credential is passed, so antigravity's own fetchModels returns
      // early without ever calling fetch. withEndpointCatalog has no such gate
      // and would fetch regardless — this is what distinguishes "left alone"
      // from "silently rewrapped".
      await models.getProvider('ag')?.refreshModels?.({
        store: { read: async () => undefined, write: async () => {}, delete: async () => {} },
        allowNetwork: true
      })
      expect(calls).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
