import { describe, expect, it } from 'bun:test'
import { createRouter } from '../app'
import type { RouterOptions } from '../types'

const baseOptions: RouterOptions = {
  server: { port: 3000, host: '127.0.0.1' },
  auth: { apiKeys: ['test-key'] },
  providers: {
    p1: {
      type: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      accounts: [{ type: 'api-key', name: 'existing', key: 'k' }],
      balancing: { strategy: 'round-robin' }
    }
  },
  authDir: `/tmp/admin-test-${crypto.randomUUID()}`,
  routing: { rules: [], scenarios: {}, default: { provider: 'p1' } },
  telemetry: { level: 'info' }
} as RouterOptions

describe('admin HTTP', () => {
  it('returns 404 for /admin/* when admin opt not set', async () => {
    const router = createRouter(baseOptions)
    const res = await router.app.fetch(new Request('http://x/admin/accounts'))
    expect(res.status).toBe(404)
  })

  it('throws when admin opt set with empty authKey', () => {
    expect(() => createRouter(baseOptions, { admin: { authKey: '' } })).toThrow()
  })

  it('returns 401 without bearer', async () => {
    const router = createRouter(baseOptions, { admin: { authKey: 'admin-key' } })
    const res = await router.app.fetch(new Request('http://x/admin/accounts'))
    expect(res.status).toBe(401)
  })

  it('GET /admin/accounts returns bare array', async () => {
    const router = createRouter(baseOptions, { admin: { authKey: 'admin-key' } })
    const res = await router.app.fetch(
      new Request('http://x/admin/accounts', {
        headers: { Authorization: 'Bearer admin-key' }
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body[0].provider).toBe('p1')
    expect(body[0].account.name).toBe('existing')
  })

  it('POST /admin/accounts/:provider creates account', async () => {
    const router = createRouter(baseOptions, { admin: { authKey: 'admin-key' } })
    const res = await router.app.fetch(
      new Request('http://x/admin/accounts/p1', {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'api-key', name: 'new', key: 'sk-new' })
      })
    )
    expect(res.status).toBe(201)
    expect(router.options.providers.p1?.accounts.map((a) => a.name)).toContain('new')
  })

  it('POST duplicate name returns 409', async () => {
    const router = createRouter(baseOptions, { admin: { authKey: 'admin-key' } })
    const res = await router.app.fetch(
      new Request('http://x/admin/accounts/p1', {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'api-key', name: 'existing', key: 'k' })
      })
    )
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('account_conflict')
  })

  it('POST to unknown provider returns 404', async () => {
    const router = createRouter(baseOptions, { admin: { authKey: 'admin-key' } })
    const res = await router.app.fetch(
      new Request('http://x/admin/accounts/nope', {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'api-key', name: 'x', key: 'k' })
      })
    )
    expect(res.status).toBe(404)
  })

  it('DELETE /admin/accounts/:provider/:name removes account', async () => {
    const router = createRouter(baseOptions, { admin: { authKey: 'admin-key' } })
    const res = await router.app.fetch(
      new Request('http://x/admin/accounts/p1/existing', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer admin-key' }
      })
    )
    expect(res.status).toBe(204)
    expect(router.options.providers.p1?.accounts).toHaveLength(0)
  })

  it('PATCH disabled=true toggles account', async () => {
    const router = createRouter(baseOptions, { admin: { authKey: 'admin-key' } })
    const res = await router.app.fetch(
      new Request('http://x/admin/accounts/p1/existing', {
        method: 'PATCH',
        headers: { Authorization: 'Bearer admin-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled: true })
      })
    )
    expect(res.status).toBe(204)
    expect(router.options.providers.p1?.accounts[0]?.disabled).toBe(true)
  })

  it('PATCH with invalid body returns 400', async () => {
    const router = createRouter(baseOptions, { admin: { authKey: 'admin-key' } })
    const res = await router.app.fetch(
      new Request('http://x/admin/accounts/p1/existing', {
        method: 'PATCH',
        headers: { Authorization: 'Bearer admin-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled: 'yes' })
      })
    )
    expect(res.status).toBe(400)
  })
})
