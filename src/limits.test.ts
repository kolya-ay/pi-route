import { afterEach, describe, expect, it } from 'bun:test'
import type { MutableModels } from '@earendil-works/pi-ai'
import { collectLimitsSnapshot, planFromTier } from './limits'
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

describe('planFromTier', () => {
  it('maps every tier spelling the API has used', () => {
    expect(planFromTier('default_claude_max_5x')).toBe('Max 5x')
    expect(planFromTier('default_claude_max_20x')).toBe('Max 20x')
    expect(planFromTier('default_max_20x')).toBe('Max 20x')
    expect(planFromTier('default_pro')).toBe('Pro')
    expect(planFromTier('claude_free')).toBe('Free')
    expect(planFromTier('default_team')).toBe('Team')
  })

  it('an unknown tier is surfaced rather than dropped', () => {
    expect(planFromTier('default_claude_ultra')).toBe('Ultra')
  })

  it('a missing tier is null', () => {
    expect(planFromTier(null)).toBe(null)
    expect(planFromTier('')).toBe(null)
  })
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
          windows: [],
          spend: null,
          account: null,
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
      // This mock serves no profile (only /oauth/usage is handled), and plan
      // now comes exclusively from the profile — so null is the honest result,
      // not an oversight.
      plan: null,
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

  it('the plan comes from the profile endpoint, alongside usage', async () => {
    const requestedUrls: string[] = []
    globalThis.fetch = (async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      requestedUrls.push(url)

      if (url === 'https://api.anthropic.com/api/oauth/profile') {
        return new Response(
          JSON.stringify({
            account: { email: 'someone@example.test' },
            organization: {
              rate_limit_tier: 'default_claude_max_5x',
              organization_type: 'claude_max'
            }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }

      if (url === 'https://api.anthropic.com/api/oauth/usage') {
        return new Response(
          JSON.stringify({
            five_hour: { utilization: 12, resets_at: null },
            seven_day: null
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }

      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const state = mkState(
      {
        providers: {
          claude: {
            type: 'anthropic',
            account: { credential: 'oauth', name: 'claude-oauth' }
          }
        },
        pipeline: [],
        expose: []
      },
      { claude: 'claude-token' }
    )

    const snapshot = await collectLimitsSnapshot(state)
    expect(snapshot.providers[0]).toMatchObject({
      plan: 'Max 5x',
      session: { used_percent: 12 }
    })
    expect(requestedUrls).toContain('https://api.anthropic.com/api/oauth/profile')
  })

  it('a failed profile leaves the row ok with no plan', async () => {
    globalThis.fetch = (async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

      if (url === 'https://api.anthropic.com/api/oauth/profile') {
        return new Response('server error', { status: 500 })
      }

      if (url === 'https://api.anthropic.com/api/oauth/usage') {
        return new Response(
          JSON.stringify({
            five_hour: { utilization: 12, resets_at: null },
            seven_day: null
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }

      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const state = mkState(
      {
        providers: {
          claude: {
            type: 'anthropic',
            account: { credential: 'oauth', name: 'claude-oauth' }
          }
        },
        pipeline: [],
        expose: []
      },
      { claude: 'claude-token' }
    )

    const snapshot = await collectLimitsSnapshot(state)
    expect(snapshot.providers[0]).toMatchObject({
      status: 'ok',
      plan: null,
      session: { used_percent: 12 }
    })
  })

  it('a codex window shorter than a week stays the session window', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          plan_type: 'plus',
          rate_limit: {
            primary_window: { used_percent: 40, limit_window_seconds: 18000, reset_at: 1785181568 },
            secondary_window: null
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as unknown as typeof fetch

    const state = mkState(
      {
        providers: {
          codex: {
            type: 'openai-codex',
            account: { credential: 'oauth', name: 'codex-oauth' }
          }
        },
        pipeline: [],
        expose: []
      },
      { codex: 'codex-token' }
    )

    const snapshot = await collectLimitsSnapshot(state)
    expect(snapshot.providers[0]).toMatchObject({
      session: { used_percent: 40, resets_at: new Date(1785181568 * 1000).toISOString() },
      weekly: null
    })
  })

  it('anthropic reports windows, spend, and account beside the existing shape', async () => {
    globalThis.fetch = (async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

      if (url === 'https://api.anthropic.com/api/oauth/profile') {
        return new Response(
          JSON.stringify({
            account: { email: 'someone@example.test' },
            organization: { organization_type: 'claude_max' }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }

      if (url === 'https://api.anthropic.com/api/oauth/usage') {
        return new Response(
          JSON.stringify({
            five_hour: { utilization: 42, resets_at: '2026-07-05T10:00:00.000Z' },
            seven_day: { utilization: 12, resets_at: '2026-07-10T00:00:00.000Z' },
            limits: [
              {
                kind: 'session',
                percent: 42,
                resets_at: '2026-07-05T10:00:00.000Z',
                is_active: true
              },
              {
                kind: 'weekly_scoped',
                percent: 5,
                resets_at: '2026-07-10T00:00:00.000Z',
                is_active: false,
                scope: { model: { display_name: 'Fable' } }
              }
            ],
            spend: {
              used: { amount_minor: 10222, exponent: 2, currency: 'USD' },
              limit: { amount_minor: 10000, exponent: 2 },
              enabled: false,
              disabled_reason: 'org_level_disabled_until'
            }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }

      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const state = mkState(
      {
        providers: {
          claude: {
            type: 'anthropic',
            account: { credential: 'oauth', name: 'claude-oauth' }
          }
        },
        pipeline: [],
        expose: []
      },
      { claude: 'claude-token' }
    )

    const snapshot = await collectLimitsSnapshot(state)
    const claude = snapshot.providers[0]!
    expect(claude.windows.map((w) => w.kind)).toEqual(['session', 'weekly_scoped'])
    expect(claude.windows[1]).toMatchObject({
      kind: 'weekly_scoped',
      used_percent: 5,
      active: false,
      scope: 'Fable'
    })
    expect(claude.spend).toEqual({
      used: 102.22,
      cap: 100,
      currency: 'USD',
      enabled: false,
      disabled_reason: 'org_level_disabled_until'
    })
    expect(claude.account).toEqual({
      email: 'someone@example.test',
      organization_type: 'claude_max'
    })
  })

  it('codex reports windows, and spend and account as empty rather than absent', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          plan_type: 'plus',
          email: 'someone@example.test',
          rate_limit: {
            primary_window: { used_percent: 3, limit_window_seconds: 604800, reset_at: 1785181568 },
            secondary_window: null
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as unknown as typeof fetch

    const state = mkState(
      {
        providers: {
          codex: {
            type: 'openai-codex',
            account: { credential: 'oauth', name: 'codex-oauth' }
          }
        },
        pipeline: [],
        expose: []
      },
      { codex: 'codex-token' }
    )

    const snapshot = await collectLimitsSnapshot(state)
    const codex = snapshot.providers[0]!
    // A seven-day window declared as `primary_window` is weekly, not session —
    // this subsumes the plain "which window role" assertion.
    expect(codex.plan).toBe('Plus')
    expect(codex.session).toBe(null)
    expect(codex.weekly).toEqual({
      used_percent: 3,
      resets_at: new Date(1785181568 * 1000).toISOString()
    })
    expect(codex.windows).toEqual([
      {
        kind: 'weekly',
        used_percent: 3,
        resets_at: new Date(1785181568 * 1000).toISOString(),
        window_seconds: 604800,
        active: true,
        scope: null
      }
    ])
    expect(codex.spend).toBe(null)
    expect(codex.account).toEqual({ email: 'someone@example.test', organization_type: null })
  })

  it('a reset time that would overflow Date does not fail the whole row', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          plan_type: 'plus',
          rate_limit: {
            // Upstream switching reset_at to milliseconds is a plausible future
            // change; the resulting seconds*1000 value overflows Date's range.
            primary_window: {
              used_percent: 3,
              limit_window_seconds: 604800,
              reset_at: 9_000_000_000_000
            },
            secondary_window: null
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as unknown as typeof fetch

    const state = mkState(
      {
        providers: {
          codex: {
            type: 'openai-codex',
            account: { credential: 'oauth', name: 'codex-oauth' }
          }
        },
        pipeline: [],
        expose: []
      },
      { codex: 'codex-token' }
    )

    const snapshot = await collectLimitsSnapshot(state)
    expect(snapshot.providers[0]).toMatchObject({
      status: 'ok',
      plan: 'Plus',
      weekly: { used_percent: 3, resets_at: null }
    })
  })

  it('a non-positive reset time is treated as unset, not a 1970 date', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          plan_type: 'plus',
          rate_limit: {
            primary_window: { used_percent: 3, limit_window_seconds: 18000, reset_at: 0 },
            secondary_window: null
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as unknown as typeof fetch

    const state = mkState(
      {
        providers: {
          codex: {
            type: 'openai-codex',
            account: { credential: 'oauth', name: 'codex-oauth' }
          }
        },
        pipeline: [],
        expose: []
      },
      { codex: 'codex-token' }
    )

    const snapshot = await collectLimitsSnapshot(state)
    expect(snapshot.providers[0]).toMatchObject({
      session: { used_percent: 3, resets_at: null }
    })
  })

  it('a rejected usage fetch degrades only that provider, not the whole snapshot', async () => {
    globalThis.fetch = (async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

      if (url === 'https://api.anthropic.com/api/oauth/profile') {
        return new Response(
          JSON.stringify({
            account: { email: 'someone@example.test' },
            organization: { rate_limit_tier: 'default_pro' }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }

      if (url === 'https://api.anthropic.com/api/oauth/usage') {
        throw new TypeError('fetch failed')
      }

      if (url === 'https://chatgpt.com/backend-api/wham/usage') {
        return new Response(
          JSON.stringify({
            plan_type: 'plus',
            rate_limit: {
              primary_window: { used_percent: 7, limit_window_seconds: 18000, reset_at: null },
              secondary_window: null
            }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
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
      { claude: 'claude-token', codex: 'codex-token' }
    )

    const snapshot = await collectLimitsSnapshot(state)
    expect(snapshot.providers[0]).toMatchObject({ name: 'claude', status: 'error' })
    expect(snapshot.providers[1]).toMatchObject({
      name: 'codex',
      status: 'ok',
      session: { used_percent: 7 }
    })
  })

  it('a missing money exponent is absence, not a fabricated 100x value', async () => {
    globalThis.fetch = (async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

      if (url === 'https://api.anthropic.com/api/oauth/profile') {
        return new Response('not found', { status: 404 })
      }

      if (url === 'https://api.anthropic.com/api/oauth/usage') {
        return new Response(
          JSON.stringify({
            five_hour: { utilization: 1, resets_at: null },
            spend: {
              used: { amount_minor: 1234, currency: 'USD' },
              limit: { amount_minor: 10000, exponent: 2 },
              enabled: true,
              disabled_reason: null
            }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }

      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const state = mkState(
      {
        providers: {
          claude: {
            type: 'anthropic',
            account: { credential: 'oauth', name: 'claude-oauth' }
          }
        },
        pipeline: [],
        expose: []
      },
      { claude: 'claude-token' }
    )

    const snapshot = await collectLimitsSnapshot(state)
    expect(snapshot.providers[0]?.spend).toBe(null)
  })

  it('spend currency falls back to the limit side when the used side omits it', async () => {
    globalThis.fetch = (async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

      if (url === 'https://api.anthropic.com/api/oauth/profile') {
        return new Response('not found', { status: 404 })
      }

      if (url === 'https://api.anthropic.com/api/oauth/usage') {
        return new Response(
          JSON.stringify({
            five_hour: { utilization: 1, resets_at: null },
            spend: {
              used: { amount_minor: 500, exponent: 2 },
              limit: { amount_minor: 10000, exponent: 2, currency: 'EUR' },
              enabled: true,
              disabled_reason: null
            }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }

      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const state = mkState(
      {
        providers: {
          claude: {
            type: 'anthropic',
            account: { credential: 'oauth', name: 'claude-oauth' }
          }
        },
        pipeline: [],
        expose: []
      },
      { claude: 'claude-token' }
    )

    const snapshot = await collectLimitsSnapshot(state)
    expect(snapshot.providers[0]?.spend).toMatchObject({ currency: 'EUR' })
  })

  it('an absent is_active flag is unknown, not inactive', async () => {
    globalThis.fetch = (async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

      if (url === 'https://api.anthropic.com/api/oauth/profile') {
        return new Response('not found', { status: 404 })
      }

      if (url === 'https://api.anthropic.com/api/oauth/usage') {
        return new Response(
          JSON.stringify({
            five_hour: { utilization: 1, resets_at: null },
            limits: [{ kind: 'session', percent: 10, resets_at: null }]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }

      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const state = mkState(
      {
        providers: {
          claude: {
            type: 'anthropic',
            account: { credential: 'oauth', name: 'claude-oauth' }
          }
        },
        pipeline: [],
        expose: []
      },
      { claude: 'claude-token' }
    )

    const snapshot = await collectLimitsSnapshot(state)
    expect(snapshot.providers[0]?.windows[0]).toMatchObject({ active: true })
  })

  it('no profile and no organization fields collapse to a null account, not a hollow object', async () => {
    globalThis.fetch = (async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

      if (url === 'https://api.anthropic.com/api/oauth/profile') {
        return new Response('server error', { status: 500 })
      }

      if (url === 'https://api.anthropic.com/api/oauth/usage') {
        return new Response(JSON.stringify({ five_hour: { utilization: 1, resets_at: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }

      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const state = mkState(
      {
        providers: {
          claude: {
            type: 'anthropic',
            account: { credential: 'oauth', name: 'claude-oauth' }
          }
        },
        pipeline: [],
        expose: []
      },
      { claude: 'claude-token' }
    )

    const snapshot = await collectLimitsSnapshot(state)
    expect(snapshot.providers[0]?.account).toBe(null)
  })

  it('a codex payload with no email also collapses to a null account, not a hollow object', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          plan_type: 'plus',
          rate_limit: {
            primary_window: { used_percent: 3, limit_window_seconds: 18000, reset_at: null },
            secondary_window: null
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as unknown as typeof fetch

    const state = mkState(
      {
        providers: {
          codex: {
            type: 'openai-codex',
            account: { credential: 'oauth', name: 'codex-oauth' }
          }
        },
        pipeline: [],
        expose: []
      },
      { codex: 'codex-token' }
    )

    const snapshot = await collectLimitsSnapshot(state)
    expect(snapshot.providers[0]?.account).toBe(null)
  })
})
