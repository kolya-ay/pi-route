import { describe, expect, it } from 'bun:test'

import { createApp } from './app'
import type { RouterOptions } from './types'

const testOptions: RouterOptions = {
  server: { port: 3000, host: 'localhost' },
  auth: { apiKeys: [] },
  authDir: '~/.config/hono-router/auth',
  providers: {
    'test-provider': {
      type: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      accounts: [{ type: 'api-key', name: 'test-account', resolveKey: () => 'sk-test-key' }],
      balancing: { strategy: 'round-robin' }
    }
  },
  routing: {
    rules: [
      { match: 'claude-sonnet-4-20250514', provider: 'test-provider' },
      { match: 'claude-*', provider: 'test-provider' }
    ],
    scenarios: {},
    default: { provider: 'test-provider' }
  },
  telemetry: { level: 'info' }
}

const authedOptions: RouterOptions = { ...testOptions, auth: { apiKeys: ['test-secret-key'] } }

describe('GET /', () => {
  it('returns 200 with name', async () => {
    const app = createApp(testOptions)
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['name']).toBe('hono-router')
    expect(body['status']).toBe('ok')
  })
})

describe('GET /health', () => {
  it('returns 200 with status ok and providers', async () => {
    const app = createApp(testOptions)
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['status']).toBe('ok')
    expect(body['providers']).toBeDefined()
    const providers = body['providers'] as Record<string, unknown>
    expect(providers['test-provider']).toBeDefined()
  })
})

describe('GET /v1/models', () => {
  it('returns 200 with list object', async () => {
    const app = createApp(testOptions)
    const res = await app.request('/v1/models')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['object']).toBe('list')
    const data = body['data'] as Array<Record<string, unknown>>
    expect(data.length).toBe(1)
    expect(data[0]?.['id']).toBe('claude-sonnet-4-20250514')
  })
})

describe('/v1/* middleware', () => {
  it('sets x-request-id header', async () => {
    const app = createApp(testOptions)
    const res = await app.request('/v1/models')
    expect(res.headers.get('x-request-id')).toBeTruthy()
  })

  it('rejects with 401 when auth configured and no key', async () => {
    const app = createApp(authedOptions)
    const res = await app.request('/v1/models')
    expect(res.status).toBe(401)
  })

  it('allows with valid bearer key', async () => {
    const app = createApp(authedOptions)
    const res = await app.request('/v1/models', {
      headers: { Authorization: 'Bearer test-secret-key' }
    })
    expect(res.status).toBe(200)
  })
})
