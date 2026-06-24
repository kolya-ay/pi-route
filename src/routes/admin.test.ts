import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { readRuntimeState } from '../config/state'
import { buildCatalog } from '../pipeline/catalog'
import { createState, type RouterState } from '../state'
import type { RouterOptions, TelemetryEmitter } from '../types'
import { mountAdmin } from './admin'

const telemetry: TelemetryEmitter = { sinks: [], emit() {} }
const authKey = 'secret'

const baseOpts: RouterOptions = {
  providers: {
    foo: { type: 'cerebras', account: { credential: 'key', key: 'k' } }
  },
  pipeline: [],
  expose: []
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pi-admin-routes-'))
})

const mkApp = (
  options: RouterOptions = baseOpts
): { app: Hono<{ Variables: { requestId: string } }>; state: RouterState } => {
  const state = createState(options, buildCatalog(options), { accounts: {} }, dir, telemetry)
  const app = new Hono<{ Variables: { requestId: string } }>()
  mountAdmin(app, state, { authKey })
  return { app, state }
}

const auth = { Authorization: `Bearer ${authKey}` }

describe('admin HTTP', () => {
  test('rejects requests without auth', async () => {
    const { app } = mkApp()
    const r = await app.request('/admin/accounts')
    expect(r.status).toBe(401)
  })

  test('GET /admin/accounts lists accounts', async () => {
    const { app } = mkApp()
    const r = await app.request('/admin/accounts', { headers: auth })
    expect(r.status).toBe(200)
    const body = (await r.json()) as Record<string, unknown>[]
    expect(body).toHaveLength(1)
    expect(body[0]!.name).toBe('foo')
    expect(body[0]!.type).toBe('cerebras')
  })

  test('GET /admin/accounts/:name returns one entry', async () => {
    const { app } = mkApp()
    const r = await app.request('/admin/accounts/foo', { headers: auth })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { name: string }
    expect(body.name).toBe('foo')
  })

  test('GET /admin/accounts/:name 404s for unknown name', async () => {
    const { app } = mkApp()
    const r = await app.request('/admin/accounts/nope', { headers: auth })
    expect(r.status).toBe(404)
  })

  test('PATCH /admin/accounts/:name/invalid toggles isInvalid and persists', async () => {
    const { app, state } = mkApp()
    const r = await app.request('/admin/accounts/foo/invalid', {
      method: 'PATCH',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ isInvalid: true })
    })
    expect(r.status).toBe(204)
    expect(state.runtime.accounts.foo!.isInvalid).toBe(true)
    const onDisk = await readRuntimeState(dir)
    expect(onDisk.accounts.foo!.isInvalid).toBe(true)
  })

  test('PATCH /admin/accounts/:name/invalid validates body', async () => {
    const { app } = mkApp()
    const r = await app.request('/admin/accounts/foo/invalid', {
      method: 'PATCH',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({})
    })
    expect(r.status).toBe(400)
  })

  test('PATCH /admin/accounts/:name/invalid 404s on unknown account', async () => {
    const { app } = mkApp()
    const r = await app.request('/admin/accounts/nope/invalid', {
      method: 'PATCH',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ isInvalid: true })
    })
    expect(r.status).toBe(404)
  })

  test('POST /admin/accounts/:name/login returns 405 (login moved to CLI)', async () => {
    const { app } = mkApp()
    const r = await app.request('/admin/accounts/foo/login', {
      method: 'POST',
      headers: auth
    })
    expect(r.status).toBe(405)
    const body = (await r.json()) as { error: string }
    expect(body.error).toBe('method_not_allowed')
  })
})
