import { afterEach, describe, expect, it } from 'bun:test'
import type { MutableModels } from '@earendil-works/pi-ai'
import { collectLimitsSnapshot } from './limits'
import { createState } from './state'
import type { RouterOptions } from './types'

const originalFetch = globalThis.fetch

// collectLimitsSnapshot only calls `models.getAuth(providerId)`. Stub it to
// resolve directly from an in-memory token map instead of exercising the real
// OAuth/credential-store machinery.
const stubModels = (tokens: Record<string, string>): MutableModels =>
  ({
    getAuth: async (providerId: string) => {
      const apiKey = tokens[providerId]
      return apiKey ? { auth: { apiKey } } : undefined
    }
  }) as unknown as MutableModels

const mkState = (options: RouterOptions, tokens: Record<string, string> = {}) =>
  createState(options, null as never, stubModels(tokens), { accounts: {} }, '')

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('collectLimitsSnapshot', () => {
  it('returns an empty providers array when no supported providers are configured', async () => {
    const state = mkState({
      providers: {
        router: {
          type: 'openrouter',
          account: { credential: 'key', key: 'sk-test' }
        }
      },
      pipeline: [],
      expose: []
    })

    expect(await collectLimitsSnapshot(state)).toEqual({ providers: [] })
  })

  it('returns only configured anthropic and openai-codex providers', async () => {
    const state = mkState({
      providers: {
        claude: {
          type: 'anthropic',
          account: { credential: 'key', key: 'sk-ant-test' }
        },
        codex: {
          type: 'openai-codex',
          account: { credential: 'key', key: 'sk-codex-test' }
        },
        ignored: {
          type: 'openai',
          account: { credential: 'key', key: 'sk-openai-test' }
        }
      },
      pipeline: [],
      expose: []
    })

    const snapshot = await collectLimitsSnapshot(state)
    expect(snapshot.providers).toHaveLength(2)
    expect(snapshot.providers.map((provider) => provider.name)).toEqual(['claude', 'codex'])
    expect(snapshot.providers.map((provider) => provider.type)).toEqual([
      'anthropic',
      'openai-codex'
    ])
    expect(snapshot.providers.every((provider) => provider.status === 'unauthenticated')).toBe(true)
  })

  it('returns an unauthenticated entry when an oauth credential is missing', async () => {
    const state = mkState({
      providers: {
        codex: {
          type: 'openai-codex',
          account: { credential: 'oauth', name: 'missing' }
        }
      },
      pipeline: [],
      expose: []
    })

    await expect(collectLimitsSnapshot(state)).resolves.toEqual({
      providers: [
        {
          name: 'codex',
          type: 'openai-codex',
          display_name: 'Codex',
          status: 'unauthenticated',
          plan: null,
          session: null,
          weekly: null,
          credits: null,
          error_message: 'OAuth login required for Codex usage.',
          last_updated: null
        }
      ]
    })
  })

  it('converts thrown provider errors into local error entries instead of rejecting the whole snapshot', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch

    const state = mkState(
      {
        providers: {
          claude: {
            type: 'anthropic',
            account: { credential: 'oauth', name: 'claude-oauth' }
          },
          codex: {
            type: 'openai-codex',
            account: { credential: 'key', key: 'sk-codex-test' }
          }
        },
        pipeline: [],
        expose: []
      },
      { claude: 'claude-token' }
    )

    await expect(collectLimitsSnapshot(state)).resolves.toMatchObject({
      providers: [
        {
          name: 'claude',
          type: 'anthropic',
          status: 'error',
          session: null,
          weekly: null,
          credits: null
        },
        {
          name: 'codex',
          type: 'openai-codex',
          status: 'unauthenticated'
        }
      ]
    })
  })

  it('keeps provider failures local and still returns successful entries', async () => {
    globalThis.fetch = (async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === 'https://api.anthropic.com/api/oauth/usage') {
        return new Response(
          JSON.stringify({
            rate_limit_tier: 'default_pro',
            subscription_type: 'pro',
            five_hour: { utilization: 42, resets_at: '2026-07-05T10:00:00.000Z' },
            seven_day: { utilization: 12, resets_at: '2026-07-10T00:00:00.000Z' },
            seven_day_omelette: { utilization: 99, resets_at: '2026-07-10T00:00:00.000Z' },
            extra_usage: {
              is_enabled: false,
              monthly_limit: 0,
              used_credits: 0
            }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }

      if (url === 'https://chatgpt.com/backend-api/wham/usage') {
        return new Response('forbidden', { status: 403 })
      }

      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const state = mkState(
      {
        providers: {
          claude: {
            type: 'anthropic',
            account: { credential: 'oauth', name: 'claude-oauth' }
          },
          codex: {
            type: 'openai-codex',
            account: { credential: 'oauth', name: 'codex-oauth' }
          }
        },
        pipeline: [],
        expose: []
      },
      {
        claude: 'claude-token',
        codex:
          'header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC0xIn19.sig'
      }
    )

    const snapshot = await collectLimitsSnapshot(state)
    expect(snapshot.providers).toHaveLength(2)
    expect(snapshot.providers[0]).toMatchObject({
      name: 'claude',
      type: 'anthropic',
      status: 'ok',
      plan: 'Pro',
      session: { used_percent: 42, resets_at: '2026-07-05T10:00:00.000Z' },
      weekly: { used_percent: 12, resets_at: '2026-07-10T00:00:00.000Z' },
      credits: null,
      error_message: null
    })
    expect(snapshot.providers[1]).toMatchObject({
      name: 'codex',
      type: 'openai-codex',
      status: 'error',
      session: null,
      weekly: null,
      credits: null,
      error_message: 'Re-authenticate in the Codex CLI.'
    })
  })
})
