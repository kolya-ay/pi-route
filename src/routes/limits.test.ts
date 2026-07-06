import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeCredentials } from '../auth/credentials'
import { buildCatalog } from '../pipeline/catalog'
import { createState } from '../state'
import { createTel } from '../telemetry/tel'
import type { RouterOptions } from '../types'
import { createLimitsRoute } from './limits'

const originalFetch = globalThis.fetch

const makeTempDir = async () => mkdtemp(join(tmpdir(), 'pi-route-limits-route-'))

const makeState = (options: RouterOptions, authDir: string) =>
  createState(options, buildCatalog(options), { accounts: {} }, authDir)

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('/v1/limits', () => {
  it('returns HTTP 200 and an empty providers array when no supported providers are configured', async () => {
    const dir = await makeTempDir()

    try {
      const options: RouterOptions = {
        providers: {
          router: { type: 'openrouter', account: { credential: 'key', key: 'sk-test' } }
        },
        pipeline: [],
        expose: []
      }
      const app = createLimitsRoute(makeState(options, dir), createTel())
      const response = await app.request('/')

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ providers: [] })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns only configured anthropic and openai-codex entries', async () => {
    const dir = await makeTempDir()

    try {
      const options: RouterOptions = {
        providers: {
          claude: { type: 'anthropic', account: { credential: 'key', key: 'sk-ant' } },
          codex: { type: 'openai-codex', account: { credential: 'key', key: 'sk-codex' } },
          ignored: { type: 'openai', account: { credential: 'key', key: 'sk-openai' } }
        },
        pipeline: [],
        expose: []
      }
      const app = createLimitsRoute(makeState(options, dir), createTel())
      const response = await app.request('/')
      const body = (await response.json()) as { providers: { name: string; type: string }[] }

      expect(response.status).toBe(200)
      expect(body.providers.map((provider) => provider.name)).toEqual(['claude', 'codex'])
      expect(body.providers.map((provider) => provider.type)).toEqual(['anthropic', 'openai-codex'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns mixed provider statuses in one response', async () => {
    const dir = await makeTempDir()
    await writeCredentials(dir, 'claude-oauth', {
      provider: 'anthropic',
      refresh: 'refresh-1',
      access: 'claude-token',
      expires: Date.now() + 60_000
    })
    await writeCredentials(dir, 'codex-oauth', {
      provider: 'openai-codex',
      refresh: 'refresh-2',
      access:
        'header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC0xIn19.sig',
      expires: Date.now() + 60_000
    })

    globalThis.fetch = (async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === 'https://api.anthropic.com/api/oauth/usage') {
        return new Response(
          JSON.stringify({
            rate_limit_tier: 'default_pro',
            five_hour: { utilization: 11, resets_at: '2026-07-05T10:00:00.000Z' },
            seven_day: { utilization: 22, resets_at: '2026-07-10T00:00:00.000Z' },
            extra_usage: { is_enabled: false, monthly_limit: 0, used_credits: 0 }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }

      if (url === 'https://chatgpt.com/backend-api/wham/usage') {
        return new Response('forbidden', { status: 403 })
      }

      return new Response('not found', { status: 404 })
    }) as typeof fetch

    try {
      const options: RouterOptions = {
        providers: {
          claude: { type: 'anthropic', account: { credential: 'oauth', name: 'claude-oauth' } },
          codex: { type: 'openai-codex', account: { credential: 'oauth', name: 'codex-oauth' } }
        },
        pipeline: [],
        expose: []
      }
      const app = createLimitsRoute(makeState(options, dir), createTel())
      const response = await app.request('/')
      const body = (await response.json()) as {
        providers: { name: string; status: string; error_message: string | null }[]
      }

      expect(response.status).toBe(200)
      expect(body.providers).toHaveLength(2)
      expect(body.providers[0]).toMatchObject({ name: 'claude', status: 'ok', error_message: null })
      expect(body.providers[1]).toMatchObject({
        name: 'codex',
        status: 'error',
        error_message: 'Re-authenticate in the Codex CLI.'
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
