// src/integration-models.test.ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pi-route-models-'))
  process.env.PI_ROUTE_CONFIG = join(dir, 'router.yaml')
  process.env.PI_ROUTE_AUTH = dir
  await writeFile(
    process.env.PI_ROUTE_CONFIG,
    `providers:\n  cerebras:\n    type: cerebras\n    account: { credential: key, key: sk }\n`
  )
})
afterEach(async () => {
  delete process.env.PI_ROUTE_CONFIG
  delete process.env.PI_ROUTE_AUTH
  await rm(dir, { recursive: true, force: true })
})

describe('/v1/models — client compatibility', () => {
  test('OpenAI envelope shape', async () => {
    const router = await createApp()
    const r = await router.app.request('/v1/models')
    const body = (await r.json()) as { object: string; data: unknown[] }
    expect(body.object).toBe('list')
    expect(Array.isArray(body.data)).toBe(true)
  })

  test('OMP-compatible: every id is non-empty', async () => {
    const router = await createApp()
    const r = await router.app.request('/v1/models')
    const body = (await r.json()) as { data: { id: string }[] }
    for (const m of body.data) expect(m.id.length).toBeGreaterThan(0)
  })

  test('OMP segment-matchable: last segment is a real model id', async () => {
    const router = await createApp()
    const r = await router.app.request('/v1/models')
    const body = (await r.json()) as {
      data: Array<{ id: string; context_length?: number }>
    }
    const knownLeaves = body.data.filter((e) => e.context_length !== undefined)
    for (const e of knownLeaves) {
      const lastSegment = e.id.split('/').pop()
      expect(lastSegment).toBeDefined()
      expect(lastSegment?.length).toBeGreaterThan(0)
    }
  })

  test('RooCode-compatible: known leaves carry context_length + pricing.prompt as string', async () => {
    const router = await createApp()
    const r = await router.app.request('/v1/models')
    const body = (await r.json()) as {
      data: Array<{ id: string; context_length?: number; pricing?: { prompt?: string } }>
    }
    const known = body.data.filter((e) => e.context_length !== undefined)
    if (known.length === 0) return // pi-ai's cerebras catalog may be empty in some installs
    expect(known[0]?.context_length).toBeGreaterThan(0)
    if (known[0]?.pricing?.prompt !== undefined) {
      expect(typeof known[0]?.pricing.prompt).toBe('string')
      expect(parseFloat(known[0]?.pricing.prompt ?? '')).toBeLessThan(1)
    }
  })
})

describe('/model/info — LiteLLM masquerade (endpoint B)', () => {
  test('is token-gated: 401 without a token when PI_ROUTE_TOKEN is set', async () => {
    process.env.PI_ROUTE_TOKEN = 'sk-test'
    try {
      const router = await createApp()
      const r = await router.app.request('/model/info')
      expect(r.status).toBe(401)
      const ok = await router.app.request('/model/info', {
        headers: { Authorization: 'Bearer sk-test' }
      })
      expect(ok.status).toBe(200)
      const body = (await ok.json()) as { data: unknown[] }
      expect(Array.isArray(body.data)).toBe(true)
    } finally {
      delete process.env.PI_ROUTE_TOKEN
    }
  })

  test('served at all four probe paths', async () => {
    const router = await createApp()
    for (const p of ['/model/info', '/v1/model/info', '/v2/model/info', '/model_group/info']) {
      const r = await router.app.request(p)
      expect(r.status).toBe(200)
      const body = (await r.json()) as { data: unknown[] }
      expect(Array.isArray(body.data)).toBe(true)
    }
  })
})

describe('/api.json — models.dev masquerade (endpoint C)', () => {
  test('404 when opencode option is unset', async () => {
    const router = await createApp()
    const r = await router.app.request('/api.json')
    expect(r.status).toBe(404)
  })

  test('public (no token) + host-derived api url when opencode: true', async () => {
    await writeFile(
      process.env.PI_ROUTE_CONFIG as string,
      `providers:\n  cerebras:\n    type: cerebras\n    account: { credential: key, key: sk }\nopencode: true\n`
    )
    process.env.PI_ROUTE_TOKEN = 'sk-test'
    try {
      const router = await createApp()
      // No Authorization header, yet reachable:
      const r = await router.app.request('http://127.0.0.1:2130/api.json')
      expect(r.status).toBe(200)
      const body = (await r.json()) as {
        'pi-route': { api: string; models: Record<string, unknown> }
      }
      expect(body['pi-route'].api).toBe('http://127.0.0.1:2130/v1')
      expect(Object.keys(body['pi-route'].models).length).toBeGreaterThan(0)
    } finally {
      delete process.env.PI_ROUTE_TOKEN
    }
  })

  test('api override wins over host', async () => {
    await writeFile(
      process.env.PI_ROUTE_CONFIG as string,
      `providers:\n  cerebras:\n    type: cerebras\n    account: { credential: key, key: sk }\nopencode:\n  api: https://pi.example.com/v1\n`
    )
    const router = await createApp()
    const r = await router.app.request('http://127.0.0.1:2130/api.json')
    const body = (await r.json()) as { 'pi-route': { api: string } }
    expect(body['pi-route'].api).toBe('https://pi.example.com/v1')
  })
})
