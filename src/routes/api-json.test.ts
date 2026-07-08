import { describe, expect, test } from 'bun:test'
import { buildCatalog } from '../pipeline/catalog'
import type { RouterOptions } from '../types'
import { buildOpencodeModels, renderApiJson, resolveApiUrl } from './api-json'

const opts = (over: Partial<RouterOptions> = {}): RouterOptions => ({
  providers: { cerebras: { type: 'cerebras', account: { credential: 'key', key: 'k' } } },
  pipeline: [],
  expose: [],
  ...over
})

describe('buildOpencodeModels', () => {
  test('keys are addresses; cost is per-MILLION verbatim', () => {
    const o = opts()
    const models = buildOpencodeModels(o, buildCatalog(o))
    const entries = Object.values(models)
    expect(entries.length).toBeGreaterThan(0)
    for (const [key, m] of Object.entries(models)) {
      expect(m.id).toBe(key)
      // per-million numbers are >= a cent-ish, not tiny per-token fractions
      if (m.cost.input !== undefined) expect(m.cost.input).toBeGreaterThan(1e-3)
    }
  })
  test('respects expose allowlist', () => {
    const o = opts({
      pipeline: [{ kind: 'alias', name: 'solo', target: 'cerebras/gpt-oss-120b' }],
      expose: ['solo']
    })
    const models = buildOpencodeModels(o, buildCatalog(o))
    expect(Object.keys(models)).toEqual(['solo'])
  })
})

describe('renderApiJson', () => {
  test('single synthetic pi-route provider wrapping the models map', () => {
    const env = renderApiJson({ 'cerebras/x': { id: 'cerebras/x' } as never }, 'http://h:1/v1')
    expect(env['pi-route'].id).toBe('pi-route')
    expect(env['pi-route'].npm).toBe('@ai-sdk/openai-compatible')
    expect(env['pi-route'].api).toBe('http://h:1/v1')
    expect(env['pi-route'].models['cerebras/x']).toBeDefined()
  })
})

describe('resolveApiUrl', () => {
  const req = (host: string | undefined, url: string, proto?: string) => ({
    header: (name: string) =>
      name.toLowerCase() === 'host'
        ? host
        : name.toLowerCase() === 'x-forwarded-proto'
          ? proto
          : undefined,
    url
  })
  test('derives <proto>://<host>/v1 from the request', () => {
    expect(resolveApiUrl(req('127.0.0.1:2130', 'http://127.0.0.1:2130/api.json'))).toBe(
      'http://127.0.0.1:2130/v1'
    )
  })
  test('honours x-forwarded-proto', () => {
    expect(resolveApiUrl(req('pi.example.com', 'http://internal/api.json', 'https'))).toBe(
      'https://pi.example.com/v1'
    )
  })
  test('override wins', () => {
    expect(resolveApiUrl(req('h', 'http://h/api.json'), 'https://x/v1')).toBe('https://x/v1')
  })
})
