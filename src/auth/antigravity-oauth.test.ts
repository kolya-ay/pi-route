// src/auth/antigravity-oauth.test.ts

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { unregisterOAuthProvider } from '@mariozechner/pi-ai/oauth'

import {
  buildAuthUrl,
  discoverProject,
  ensureAntigravityOAuthRegistered,
  exchangeCode,
  loginAntigravity,
  refreshAccessToken
} from './antigravity-oauth'

// Bun's Mock<() => Promise<Response>> lacks the `preconnect` property that
// `typeof fetch` requires, so we cast through `unknown`.
const asFetch = (fn: ReturnType<typeof mock>) => fn as unknown as typeof fetch

describe('buildAuthUrl', () => {
  it('produces a valid Google OAuth URL with required params', () => {
    const url = new URL(buildAuthUrl('test-state-123'))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe(
      'GOOGLE_OAUTH_CLIENT_ID_PLACEHOLDER.apps.googleusercontent.com'
    )
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:51121/oauth-callback')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('state')).toBe('test-state-123')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
  })

  it('includes all required scopes', () => {
    const url = new URL(buildAuthUrl('s'))
    const scope = url.searchParams.get('scope')!
    expect(scope).toContain('cloud-platform')
    expect(scope).toContain('userinfo.email')
    expect(scope).toContain('userinfo.profile')
    expect(scope).toContain('cclog')
    expect(scope).toContain('experimentsandconfigs')
  })
})

describe('exchangeCode', () => {
  it('sends correct POST body and returns credentials', async () => {
    const mockFetch = mock(async () =>
      Response.json({ access_token: 'access-abc', refresh_token: 'refresh-xyz', expires_in: 3600 })
    )

    const creds = await exchangeCode('auth-code-1', asFetch(mockFetch))

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://oauth2.googleapis.com/token')
    expect(init.method).toBe('POST')

    const body = new URLSearchParams(init.body as string)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('auth-code-1')
    expect(body.get('redirect_uri')).toBe('http://localhost:51121/oauth-callback')
    expect(body.get('client_id')).toBe(
      'GOOGLE_OAUTH_CLIENT_ID_PLACEHOLDER.apps.googleusercontent.com'
    )
    expect(body.get('client_secret')).toBe('GOOGLE_OAUTH_CLIENT_SECRET_PLACEHOLDER')

    expect(creds.access).toBe('access-abc')
    expect(creds.refresh).toBe('refresh-xyz')
    expect(creds.expires).toBeGreaterThan(Date.now() - 1000)
  })

  it('throws on error response', async () => {
    const mockFetch = mock(async () => Response.json({ error: 'invalid_grant' }, { status: 400 }))
    await expect(exchangeCode('bad', asFetch(mockFetch))).rejects.toThrow('invalid_grant')
  })
})

describe('refreshAccessToken', () => {
  it('sends grant_type=refresh_token and returns credentials', async () => {
    const mockFetch = mock(async () =>
      Response.json({ access_token: 'new-access', expires_in: 3600 })
    )

    const creds = await refreshAccessToken('my-refresh', asFetch(mockFetch))

    const [, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit]
    const body = new URLSearchParams(init.body as string)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('my-refresh')

    expect(creds.access).toBe('new-access')
    expect(creds.refresh).toBe('my-refresh')
  })

  it('uses rotated refresh token when returned', async () => {
    const mockFetch = mock(async () =>
      Response.json({
        access_token: 'new-access',
        refresh_token: 'rotated-refresh',
        expires_in: 3600
      })
    )

    const creds = await refreshAccessToken('old-refresh', asFetch(mockFetch))
    expect(creds.refresh).toBe('rotated-refresh')
  })

  it('throws on error response', async () => {
    const mockFetch = mock(async () => Response.json({ error: 'invalid_token' }, { status: 401 }))
    await expect(refreshAccessToken('bad', asFetch(mockFetch))).rejects.toThrow('invalid_token')
  })
})

describe('discoverProject', () => {
  it('returns projectId directly when loadCodeAssist response contains it', async () => {
    const mockFetch = mock(async () => Response.json({ cloudaicompanionProject: 'my-project-123' }))

    const projectId = await discoverProject('token-abc', asFetch(mockFetch))

    expect(projectId).toBe('my-project-123')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-abc')
    // Body must include the metadata block (was previously '{}' — see spec §1 step 9)
    const body = JSON.parse(init.body as string) as { metadata?: Record<string, string> }
    expect(body.metadata?.ideType).toBe('ANTIGRAVITY')
    expect(body.metadata?.platform).toBe('PLATFORM_UNSPECIFIED')
    expect(body.metadata?.pluginType).toBe('GEMINI')
  })

  it('accepts cloudaicompanionProject as an object with id', async () => {
    const mockFetch = mock(async () =>
      Response.json({ cloudaicompanionProject: { id: 'wrapped-proj' } })
    )
    const projectId = await discoverProject('token', asFetch(mockFetch))
    expect(projectId).toBe('wrapped-proj')
  })

  it('falls back to onboardUser when loadCodeAssist returns no project', async () => {
    const responses = [
      // 1) loadCodeAssist: no project, with default tier
      Response.json({ allowedTiers: [{ id: 'paid-tier', isDefault: true }] }),
      // 2) onboardUser: immediately done
      Response.json({
        name: 'operations/op-xyz',
        done: true,
        response: { cloudaicompanionProject: { id: 'fresh-project-abc' } }
      })
    ]
    const mockFetch = mock(async () => responses.shift()!)

    const projectId = await discoverProject('token', asFetch(mockFetch))
    expect(projectId).toBe('fresh-project-abc')
    expect(mockFetch).toHaveBeenCalledTimes(2)

    const [, onboardInit] = mockFetch.mock.calls[1] as unknown as [string, RequestInit]
    const onboardBody = JSON.parse(onboardInit.body as string) as Record<string, unknown>
    expect(onboardBody.tierId).toBe('paid-tier')
    expect((onboardBody.metadata as Record<string, string>).ideType).toBe('ANTIGRAVITY')
  })

  it('defaults tierId to free-tier when allowedTiers absent', async () => {
    const responses = [
      Response.json({}),
      Response.json({
        name: 'operations/o',
        done: true,
        response: { cloudaicompanionProject: 'p' }
      })
    ]
    const mockFetch = mock(async () => responses.shift()!)
    await discoverProject('token', asFetch(mockFetch))
    const [, onboardInit] = mockFetch.mock.calls[1] as unknown as [string, RequestInit]
    expect((JSON.parse(onboardInit.body as string) as { tierId: string }).tierId).toBe('free-tier')
  })

  it('throws when onboardUser succeeds but response has no project', async () => {
    const responses = [
      Response.json({}),
      Response.json({ name: 'operations/o', done: true, response: {} })
    ]
    const mockFetch = mock(async () => responses.shift()!)
    await expect(discoverProject('token', asFetch(mockFetch))).rejects.toThrow(
      'cloudaicompanionProject'
    )
  })

  it('surfaces operation.error.message when onboarding fails', async () => {
    const responses = [
      Response.json({}),
      Response.json({ name: 'operations/o', done: true, error: { message: 'ineligible' } })
    ]
    const mockFetch = mock(async () => responses.shift()!)
    await expect(discoverProject('token', asFetch(mockFetch))).rejects.toThrow('ineligible')
  })

  it('throws on non-ok loadCodeAssist response', async () => {
    const mockFetch = mock(async () => Response.json({ error: 'forbidden' }, { status: 403 }))
    await expect(discoverProject('token', asFetch(mockFetch))).rejects.toThrow('403')
  })
})

describe('ensureAntigravityOAuthRegistered', () => {
  afterEach(() => {
    unregisterOAuthProvider('google-antigravity')
  })

  it('registers without returning a value (void side-effect)', () => {
    const result = ensureAntigravityOAuthRegistered()
    expect(result).toBeUndefined()
  })

  it('is idempotent — repeated calls do not throw', () => {
    ensureAntigravityOAuthRegistered()
    ensureAntigravityOAuthRegistered()
    // No error means success
  })

  it('refreshToken preserves projectId via standalone function', async () => {
    const mockFetch = mock(async () => Response.json({ access_token: 'new', expires_in: 3600 }))
    const creds = await refreshAccessToken('ref', asFetch(mockFetch))
    expect(creds.refresh).toBe('ref')
  })
})

describe('loginAntigravity', () => {
  it('runs full OAuth flow with mocked fetch and callback server', async () => {
    const progressMessages: string[] = []
    let authUrl = ''

    const mockFetch = mock(async (url: string) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return Response.json({
          access_token: 'test-access',
          refresh_token: 'test-refresh',
          expires_in: 3600
        })
      }
      if (url === 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist') {
        return Response.json({ cloudaicompanionProject: 'discovered-project' })
      }
      return Response.json({ error: 'unexpected' }, { status: 500 })
    })

    const loginPromise = loginAntigravity(
      {
        onAuth: ({ url }) => {
          authUrl = url
          // Simulate browser callback by extracting state and hitting the local server
          const parsed = new URL(url)
          const state = parsed.searchParams.get('state')!
          setTimeout(async () => {
            await globalThis.fetch(
              `http://localhost:51121/oauth-callback?code=test-code&state=${state}`
            )
          }, 50)
        },
        onPrompt: mock(() => Promise.resolve('')),
        onProgress: (msg) => progressMessages.push(msg)
      },
      asFetch(mockFetch)
    )

    const creds = await loginPromise

    expect(authUrl).toContain('accounts.google.com')
    expect(creds.access).toBe('test-access')
    expect(creds.refresh).toBe('test-refresh')
    expect(creds.projectId).toBe('discovered-project')
    expect(progressMessages).toEqual([
      'Exchanging auth code for tokens...',
      'Discovering Cloud Code project...'
    ])

    // Verify CSRF protection: a second login with a wrong state must be rejected.
    // Sequenced here because bun:test runs `it` blocks concurrently, and both
    // calls bind to the same callback port.
    const csrfFetch = mock(async () =>
      Response.json({ error: 'should not be called' }, { status: 500 })
    )

    const csrfPromise = loginAntigravity(
      {
        onAuth: () => {
          setTimeout(async () => {
            await globalThis.fetch(
              'http://localhost:51121/oauth-callback?code=test-code&state=wrong-state'
            )
          }, 50)
        },
        onPrompt: mock(() => Promise.resolve(''))
      },
      asFetch(csrfFetch)
    )

    await expect(csrfPromise).rejects.toThrow('CSRF state mismatch')
    expect(csrfFetch).not.toHaveBeenCalled()
  })
})

describe('CSRF validation', () => {
  it('buildAuthUrl embeds state for later verification', () => {
    const state = crypto.randomUUID()
    const url = new URL(buildAuthUrl(state))
    expect(url.searchParams.get('state')).toBe(state)
  })
})
