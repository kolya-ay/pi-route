// src/integration.test.ts

import { describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import type { RouterOptions } from './types.js'

const baseOptions: RouterOptions = {
  server: { port: 3000, host: '127.0.0.1' },
  auth: { apiKeys: [] },
  backends: {
    'anthropic-backend': {
      type: 'passthrough-anthropic',
      baseUrl: 'https://api.anthropic.com',
      accounts: [{ type: 'api-key', name: 'account-1', key: 'sk-ant-test-key' }],
      balancing: { strategy: 'round-robin' },
    },
    'openai-backend': {
      type: 'passthrough-openai',
      baseUrl: 'https://api.openai.com',
      accounts: [
        { type: 'api-key', name: 'account-a', key: 'sk-openai-key-a' },
        { type: 'api-key', name: 'account-b', key: 'sk-openai-key-b' },
      ],
      balancing: { strategy: 'round-robin' },
    },
  },
  routing: {
    rules: [
      { match: 'claude-*', backend: 'anthropic-backend' },
      { match: 'gpt-*', backend: 'openai-backend' },
    ],
    scenarios: {},
    default: { backend: 'anthropic-backend' },
  },
  telemetry: { level: 'info' },
}

describe('integration: health endpoint', () => {
  it('shows both backends with account counts', async () => {
    const app = createApp(baseOptions)
    const res = await app.request('/health')

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['status']).toBe('ok')

    const backends = body['backends'] as Record<string, unknown>
    expect(backends['anthropic-backend']).toBeDefined()
    expect(backends['openai-backend']).toBeDefined()

    const anthropicEntry = backends['anthropic-backend'] as Record<string, unknown>
    const openaiEntry = backends['openai-backend'] as Record<string, unknown>

    expect(anthropicEntry['type']).toBe('passthrough-anthropic')
    expect(openaiEntry['type']).toBe('passthrough-openai')

    const anthropicAccounts = anthropicEntry['accounts'] as { total: number }
    const openaiAccounts = openaiEntry['accounts'] as { total: number }

    expect(anthropicAccounts.total).toBe(1)
    expect(openaiAccounts.total).toBe(2)
  })

  it('shows uptime as a non-negative number', async () => {
    const app = createApp(baseOptions)
    const res = await app.request('/health')
    const body = (await res.json()) as Record<string, unknown>
    expect(typeof body['uptime']).toBe('number')
    expect(body['uptime'] as number).toBeGreaterThanOrEqual(0)
  })
})

describe('integration: routing claude models to anthropic backend', () => {
  it('routes claude-* model and gets 502 with no real upstream', async () => {
    const app = createApp(baseOptions)

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    })

    // 502 is expected since there is no real upstream — the fetch will fail
    expect(res.status).toBe(502)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['error']).toBeDefined()
  })

  it('routes gpt-* model and gets an error response with no real upstream', async () => {
    const app = createApp(baseOptions)

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    })

    // No real upstream — expect a non-2xx response (502 on network failure, or
    // the actual upstream error code if the host happens to be reachable)
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})

describe('integration: 429 when all accounts are rate-limited', () => {
  it('returns 429 when all anthropic accounts are rate-limited', async () => {
    // Use 0 accounts to force pool.select() to return null → 429
    const noAccountOptions: RouterOptions = {
      ...baseOptions,
      backends: {
        'anthropic-backend': {
          type: 'passthrough-anthropic',
          baseUrl: 'https://api.anthropic.com',
          accounts: [],
          balancing: { strategy: 'round-robin' },
        },
      },
    }

    const appNoAccounts = createApp(noAccountOptions)
    const res = await appNoAccounts.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    })

    expect(res.status).toBe(429)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['error']).toContain('rate-limited')
  })
})
