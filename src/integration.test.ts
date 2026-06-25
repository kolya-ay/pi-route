// src/integration.test.ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pi-route-int-'))
  process.env.PI_ROUTE_CONFIG = join(dir, 'router.yaml')
  process.env.PI_ROUTE_AUTH = dir
})
afterEach(async () => {
  delete process.env.PI_ROUTE_CONFIG
  delete process.env.PI_ROUTE_AUTH
  await rm(dir, { recursive: true, force: true })
})

describe('integration — config shapes load and dispatch wiring works', () => {
  test('config with aliases + pools loads', async () => {
    await writeFile(
      process.env.PI_ROUTE_CONFIG!,
      `
providers:
  c1:
    type: cerebras
    account: { credential: key, key: k1 }
  c2:
    type: cerebras
    account: { credential: key, key: k2 }

pipeline:
  pool: [c1/$1, c2/$1]
  opus: c1/llama3.1-8b
`
    )
    const router = await createApp()
    const r = await router.app.request('/v1/models')
    expect(r.status).toBe(200)
    const body = (await r.json()) as { data: { id: string }[] }
    const ids = body.data.map((e) => e.id)
    expect(ids).toContain('opus')
    expect(ids.some((id) => id.startsWith('c1/'))).toBe(true)
  })

  test('expose filter narrows /v1/models', async () => {
    await writeFile(
      process.env.PI_ROUTE_CONFIG!,
      `
providers:
  c1:
    type: cerebras
    account: { credential: key, key: k1 }

pipeline:
  opus: c1/llama3.1-8b

expose:
  - opus
`
    )
    const router = await createApp()
    const r = await router.app.request('/v1/models')
    const body = (await r.json()) as { data: { id: string }[] }
    expect(body.data.map((e) => e.id)).toEqual(['opus'])
  })
})
