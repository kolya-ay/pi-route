// src/auth/antigravity-auth.test.ts

import { describe, expect, it, mock, test } from 'bun:test'

import {
  antigravityOAuth,
  buildAuthUrl,
  CLIENT_ID,
  CLIENT_SECRET,
  discoverProject,
  exchangeCode,
  PROJECT_HEADER
} from './antigravity-auth'

const SKEW_MS = 5 * 60 * 1000

const takeResponse = (responses: Response[]): Response => {
  const response = responses.shift()
  if (!response) throw new Error('missing mocked response')
  return response
}

// Never resolves on its own: settles only when the caller's signal aborts. If no
// signal arrives the promise rejects immediately with a named error, so a
// regression fails fast instead of hanging to the default test budget.
const hangingFetch =
  (seen: AbortSignal[], abortedOnArrival: boolean[] = []) =>
  (_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) {
        reject(new Error('fetch called without an abort signal'))
        return
      }
      seen.push(signal)
      abortedOnArrival.push(signal.aborted)
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })

const catchError = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise
    throw new Error('expected rejection but promise resolved')
  } catch (err) {
    return err as Error
  }
}

describe('buildAuthUrl', () => {
  it('produces a valid Google OAuth URL with required params', () => {
    const url = new URL(buildAuthUrl('test-state-123'))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:51121/oauth-callback')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('state')).toBe('test-state-123')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
  })

  it('includes all required scopes', () => {
    const url = new URL(buildAuthUrl('s'))
    const scope = url.searchParams.get('scope')
    if (!scope) throw new Error('scope missing')
    expect(scope).toContain('cloud-platform')
    expect(scope).toContain('userinfo.email')
    expect(scope).toContain('userinfo.profile')
    expect(scope).toContain('cclog')
    expect(scope).toContain('experimentsandconfigs')
  })
})

describe('exchangeCode', () => {
  it('sends correct POST body and returns skewed credentials', async () => {
    const mockFetch = mock(async () =>
      Response.json({ access_token: 'access-abc', refresh_token: 'refresh-xyz', expires_in: 3600 })
    )

    const before = Date.now()
    const creds = await exchangeCode('auth-code-1', mockFetch)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://oauth2.googleapis.com/token')
    expect(init.method).toBe('POST')

    const body = new URLSearchParams(init.body as string)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('auth-code-1')
    expect(body.get('redirect_uri')).toBe('http://localhost:51121/oauth-callback')
    expect(body.get('client_id')).toBe(CLIENT_ID)
    expect(body.get('client_secret')).toBe(CLIENT_SECRET)

    expect(creds.access).toBe('access-abc')
    expect(creds.refresh).toBe('refresh-xyz')
    expect(creds.expires).toBeGreaterThan(before)
    expect(creds.expires).toBeLessThanOrEqual(before + 3600_000 - SKEW_MS + 1000)
  })

  it('throws on error response', async () => {
    const mockFetch = mock(async () => Response.json({ error: 'invalid_grant' }, { status: 400 }))
    await expect(exchangeCode('bad', mockFetch)).rejects.toThrow('invalid_grant')
  })
})

describe('discoverProject', () => {
  it('returns projectId directly when loadCodeAssist response contains it', async () => {
    const mockFetch = mock(async () => Response.json({ cloudaicompanionProject: 'my-project-123' }))

    const projectId = await discoverProject('token-abc', mockFetch)

    expect(projectId).toBe('my-project-123')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-abc')
    const body = JSON.parse(init.body as string) as { metadata?: Record<string, string> }
    expect(body.metadata?.ideType).toBe('ANTIGRAVITY')
    expect(body.metadata?.platform).toBe('PLATFORM_UNSPECIFIED')
    expect(body.metadata?.pluginType).toBe('GEMINI')
  })

  it('accepts cloudaicompanionProject as an object with id', async () => {
    const mockFetch = mock(async () =>
      Response.json({ cloudaicompanionProject: { id: 'wrapped-proj' } })
    )
    const projectId = await discoverProject('token', mockFetch)
    expect(projectId).toBe('wrapped-proj')
  })

  it('falls back to onboardUser when loadCodeAssist returns no project', async () => {
    const responses = [
      Response.json({ allowedTiers: [{ id: 'paid-tier', isDefault: true }] }),
      Response.json({
        name: 'operations/op-xyz',
        done: true,
        response: { cloudaicompanionProject: { id: 'fresh-project-abc' } }
      })
    ]
    const mockFetch = mock(async () => takeResponse(responses))

    const projectId = await discoverProject('token', mockFetch)
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
    const mockFetch = mock(async () => takeResponse(responses))
    await discoverProject('token', mockFetch)
    const [, onboardInit] = mockFetch.mock.calls[1] as unknown as [string, RequestInit]
    expect((JSON.parse(onboardInit.body as string) as { tierId: string }).tierId).toBe('free-tier')
  })

  it('re-calls loadCodeAssist when onboardUser LRO response is empty', async () => {
    const responses = [
      Response.json({}),
      Response.json({ name: 'operations/o', done: true, response: {} }),
      Response.json({ cloudaicompanionProject: 'late-project' })
    ]
    const mockFetch = mock(async () => takeResponse(responses))
    const projectId = await discoverProject('token', mockFetch)
    expect(projectId).toBe('late-project')
    expect(mockFetch).toHaveBeenCalledTimes(3)
    const [url] = mockFetch.mock.calls[2] as unknown as [string]
    expect(url).toBe('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist')
  })

  it('throws with LRO response dump when both onboardUser and re-fetch yield no project', async () => {
    const responses = [
      Response.json({}),
      Response.json({ name: 'operations/o', done: true, response: { someField: 'unknown' } }),
      Response.json({})
    ]
    const mockFetch = mock(async () => takeResponse(responses))
    await expect(discoverProject('token', mockFetch)).rejects.toThrow(
      /LRO response: \{"someField":"unknown"\}/
    )
  })

  it('surfaces operation.error.message when onboarding fails', async () => {
    const responses = [
      Response.json({}),
      Response.json({ name: 'operations/o', done: true, error: { message: 'ineligible' } })
    ]
    const mockFetch = mock(async () => takeResponse(responses))
    await expect(discoverProject('token', mockFetch)).rejects.toThrow('ineligible')
  })

  it('aborts an unresponsive Cloud Code endpoint instead of hanging', async () => {
    const seen: AbortSignal[] = []

    const err = await catchError(discoverProject('token', hangingFetch(seen), undefined, 10))

    expect(err.name).toBe('TimeoutError')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.aborted).toBe(true)
  })

  it('gives every Cloud Code attempt its own deadline', async () => {
    const seen: AbortSignal[] = []
    const abortedOnArrival: boolean[] = []
    const responses = [Response.json({ allowedTiers: [{ id: 'free-tier', isDefault: true }] })]
    // The first call (loadCodeAssist) outlives `timeoutMs` on the wall clock, so a
    // single deadline hoisted across the whole of discoverProject would already
    // have fired before the second call (onboardUser) is even issued.
    const fetchFn = async (url: string, init?: RequestInit) => {
      if (responses.length === 0) return hangingFetch(seen, abortedOnArrival)(url, init)
      await Bun.sleep(25)
      return takeResponse(responses)
    }

    const err = await catchError(discoverProject('token', fetchFn, undefined, 10))

    expect(err.name).toBe('TimeoutError')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.aborted).toBe(true)
    // The discriminating assertion: onboardUser's signal must arrive fresh. Under a
    // shared deadline it would arrive already aborted by loadCodeAssist's 25ms.
    expect(abortedOnArrival[0]).toBe(false)
  })

  it('throws on non-ok loadCodeAssist response', async () => {
    const mockFetch = mock(async () => Response.json({ error: 'forbidden' }, { status: 403 }))
    await expect(discoverProject('token', mockFetch)).rejects.toThrow('403')
  })
})

describe('antigravityOAuth', () => {
  it('exposes the OAuthAuth shape with the Google Antigravity name', () => {
    const auth = antigravityOAuth({})
    expect(auth.name).toBe('Google Antigravity')
    expect(typeof auth.login).toBe('function')
    expect(typeof auth.refresh).toBe('function')
    expect(typeof auth.toAuth).toBe('function')
  })
})

describe('refresh', () => {
  test('refresh stamps 5-minute skew', async () => {
    const auth = antigravityOAuth({
      fetchFn: async () => new Response(JSON.stringify({ access_token: 'a2', expires_in: 3600 }))
    })
    const before = Date.now()
    const cred = await auth.refresh({
      type: 'oauth',
      refresh: 'r',
      access: 'a',
      expires: 0,
      projectId: 'p'
    })
    expect(cred.access).toBe('a2')
    expect(cred.expires).toBeLessThanOrEqual(before + 3600_000 - 5 * 60_000 + 1000)
  })

  test('sends grant_type=refresh_token with real client credentials', async () => {
    const mockFetch = mock(async () => Response.json({ access_token: 'new', expires_in: 3600 }))
    const auth = antigravityOAuth({ fetchFn: mockFetch })
    await auth.refresh({
      type: 'oauth',
      refresh: 'my-refresh',
      access: 'a',
      expires: 0,
      projectId: 'p'
    })
    const [url, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://oauth2.googleapis.com/token')
    const body = new URLSearchParams(init.body as string)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('my-refresh')
    expect(body.get('client_id')).toBe(CLIENT_ID)
    expect(body.get('client_secret')).toBe(CLIENT_SECRET)
  })

  test('keeps prior refresh token and projectId when response omits refresh_token', async () => {
    const auth = antigravityOAuth({
      fetchFn: async () => Response.json({ access_token: 'new-access', expires_in: 3600 })
    })
    const cred = await auth.refresh({
      type: 'oauth',
      refresh: 'kept-refresh',
      access: 'a',
      expires: 0,
      projectId: 'kept-project'
    })
    expect(cred.access).toBe('new-access')
    expect(cred.refresh).toBe('kept-refresh')
    expect(cred.projectId).toBe('kept-project')
  })

  test('adopts rotated refresh token when returned', async () => {
    const auth = antigravityOAuth({
      fetchFn: async () =>
        Response.json({ access_token: 'a', refresh_token: 'rotated', expires_in: 3600 })
    })
    const cred = await auth.refresh({
      type: 'oauth',
      refresh: 'old',
      access: 'a',
      expires: 0,
      projectId: 'p'
    })
    expect(cred.refresh).toBe('rotated')
  })

  test('invalid_grant is a definitive failure', async () => {
    const auth = antigravityOAuth({
      fetchFn: async () => new Response('{"error":"invalid_grant"}', { status: 400 })
    })
    await expect(
      auth.refresh({ type: 'oauth', refresh: 'r', access: 'a', expires: 0, projectId: 'p' })
    ).rejects.toThrow(/definitively/)
  })

  test('401 status is a definitive failure', async () => {
    const auth = antigravityOAuth({
      fetchFn: async () => new Response('nope', { status: 401 })
    })
    await expect(
      auth.refresh({ type: 'oauth', refresh: 'r', access: 'a', expires: 0, projectId: 'p' })
    ).rejects.toThrow(/definitively/)
  })

  test('a 500 response is NOT a definitive failure', async () => {
    const auth = antigravityOAuth({
      fetchFn: async () => new Response('{"error":"backend"}', { status: 500 })
    })
    await expect(
      auth.refresh({ type: 'oauth', refresh: 'r', access: 'a', expires: 0, projectId: 'p' })
    ).rejects.not.toThrow(/definitively/)
  })

  test('aborts an unresponsive token endpoint instead of hanging', async () => {
    const seen: AbortSignal[] = []
    const auth = antigravityOAuth({ fetchFn: hangingFetch(seen), timeoutMs: 10 })

    const err = await catchError(
      auth.refresh({ type: 'oauth', refresh: 'r', access: 'a', expires: 0, projectId: 'p' })
    )

    expect(err.name).toBe('TimeoutError')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.aborted).toBe(true)
  })

  test('composes the caller-supplied signal with the deadline', async () => {
    const seen: AbortSignal[] = []
    const auth = antigravityOAuth({ fetchFn: hangingFetch(seen), timeoutMs: 60_000 })
    const controller = new AbortController()

    const promise = auth.refresh(
      { type: 'oauth', refresh: 'r', access: 'a', expires: 0, projectId: 'p' },
      controller.signal
    )
    controller.abort()
    const err = await catchError(promise)

    expect(err.name).toBe('AbortError')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.aborted).toBe(true)
  })

  test('missing projectId is a config error', async () => {
    const auth = antigravityOAuth({
      fetchFn: async () => Response.json({ access_token: 'a', expires_in: 3600 })
    })
    await expect(
      auth.refresh({ type: 'oauth', refresh: 'r', access: 'a', expires: 0 })
    ).rejects.toThrow(/projectId/)
  })
})

describe('toAuth', () => {
  test('derives apiKey from access token and carries projectId as pseudo-header', async () => {
    const auth = antigravityOAuth({})
    expect(
      await auth.toAuth({ type: 'oauth', refresh: 'r', access: 'tok', expires: 9, projectId: 'p' })
    ).toEqual({ apiKey: 'tok', headers: { [PROJECT_HEADER]: 'p' } })
  })

  test('omits headers when the credential has no projectId', async () => {
    const auth = antigravityOAuth({})
    expect(await auth.toAuth({ type: 'oauth', refresh: 'r', access: 'tok', expires: 9 })).toEqual({
      apiKey: 'tok'
    })
  })
})
