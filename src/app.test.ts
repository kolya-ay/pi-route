// src/app.test.ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pi-route-app-'))
  process.env.PI_ROUTE_CONFIG = join(dir, 'router.yaml')
  process.env.PI_ROUTE_AUTH = dir
  await writeFile(
    process.env.PI_ROUTE_CONFIG,
    `providers:\n  cerebras:\n    type: cerebras\n    apiKey: sk-test\n`
  )
})

afterEach(async () => {
  delete process.env.PI_ROUTE_CONFIG
  delete process.env.PI_ROUTE_AUTH
  delete process.env.PI_ROUTE_TOKEN
  await rm(dir, { recursive: true, force: true })
})

describe('createApp', () => {
  test('builds a Hono app and serves /v1/models', async () => {
    const router = await createApp()
    const r = await router.app.request('/v1/models')
    expect(r.status).toBe(200)
    const body = (await r.json()) as { object: string; data: unknown[] }
    expect(body.object).toBe('list')
    expect(Array.isArray(body.data)).toBe(true)
  })

  test('health endpoint returns 200', async () => {
    const router = await createApp()
    const r = await router.app.request('/health')
    expect(r.status).toBe(200)
  })

  test('emits an x-request-id header even when client does not provide one', async () => {
    const router = await createApp()
    const res = await router.app.request('/v1/models', {
      headers: { authorization: 'Bearer t' }
    })
    expect(res.headers.get('x-request-id')).toMatch(/[0-9a-f-]{8,}/)
  })

  test('honors an inbound X-Request-Id header', async () => {
    const router = await createApp()
    const res = await router.app.request('/v1/models', {
      headers: { authorization: 'Bearer t', 'x-request-id': 'my-id-42' }
    })
    expect(res.headers.get('x-request-id')).toBe('my-id-42')
  })

  test('does not compress responses (no content-encoding on /v1/models)', async () => {
    const router = await createApp()
    const r = await router.app.request('/v1/models', {
      headers: { 'accept-encoding': 'gzip, deflate, br' }
    })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-encoding')).toBeNull()
  })

  test('/v1/limits is mounted under authenticated /v1/* routes', async () => {
    process.env.PI_ROUTE_TOKEN = 't'
    const router = await createApp()
    const response = await router.app.request('/v1/limits', {
      headers: { authorization: 'Bearer t' }
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ providers: [] })
  })
})
