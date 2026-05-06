// src/auth/antigravity-oauth.ts

import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthProviderInterface
} from '@mariozechner/pi-ai/oauth'
import { registerOAuthProvider } from '@mariozechner/pi-ai/oauth'

const CLIENT_ID = 'GOOGLE_OAUTH_CLIENT_ID_PLACEHOLDER.apps.googleusercontent.com'
const CLIENT_SECRET = 'GOOGLE_OAUTH_CLIENT_SECRET_PLACEHOLDER'
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs'
]
const CALLBACK_PORT = 51121
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/oauth-callback`
const LOGIN_TIMEOUT_MS = 300_000

type FetchFn = typeof globalThis.fetch

export const buildAuthUrl = (state: string): string => {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    access_type: 'offline',
    prompt: 'consent'
  })
  return `${AUTH_URL}?${params.toString()}`
}

export const exchangeCode = async (
  code: string,
  fetchFn: FetchFn = globalThis.fetch
): Promise<OAuthCredentials> => {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET
  })

  const response = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })

  const data = (await response.json()) as Record<string, unknown>

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${(data.error as string) ?? response.statusText}`)
  }

  return {
    access: data.access_token as string,
    refresh: data.refresh_token as string,
    expires: Date.now() + ((data.expires_in as number) ?? 3600) * 1000
  }
}

export const refreshAccessToken = async (
  refreshToken: string,
  fetchFn: FetchFn = globalThis.fetch
): Promise<OAuthCredentials> => {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET
  })

  const response = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })

  const data = (await response.json()) as Record<string, unknown>

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${(data.error as string) ?? response.statusText}`)
  }

  return {
    access: data.access_token as string,
    refresh: (data.refresh_token as string | undefined) ?? refreshToken,
    expires: Date.now() + ((data.expires_in as number) ?? 3600) * 1000
  }
}

export const discoverProject = async (
  accessToken: string,
  fetchFn: FetchFn = globalThis.fetch
): Promise<string> => {
  const response = await fetchFn('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: '{}'
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Project discovery failed (${response.status}): ${text}`)
  }

  const data = (await response.json()) as Record<string, unknown>
  const projectId = data.cloudaicompanionProject as string | undefined

  if (!projectId) {
    throw new Error(
      'Project discovery failed: no cloudaicompanionProject in loadCodeAssist response'
    )
  }

  return projectId
}

export const loginAntigravity = async (
  callbacks: OAuthLoginCallbacks,
  fetchFn: FetchFn = globalThis.fetch
): Promise<OAuthCredentials> => {
  const state = crypto.randomUUID()
  const authUrl = buildAuthUrl(state)

  const { promise, resolve, reject } = Promise.withResolvers<string>()

  const timeout = setTimeout(
    () => reject(new Error(`OAuth login timed out after ${LOGIN_TIMEOUT_MS / 1000}s`)),
    LOGIN_TIMEOUT_MS
  )

  const server = Bun.serve({
    port: CALLBACK_PORT,
    hostname: 'localhost',
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== '/oauth-callback') {
        return new Response('Not found', { status: 404 })
      }

      const returnedState = url.searchParams.get('state')
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')

      if (error) {
        reject(new Error(`OAuth error: ${error}`))
        return new Response('Authentication failed. You may close this tab.')
      }

      if (returnedState !== state) {
        reject(new Error('CSRF state mismatch'))
        return new Response('State mismatch — possible CSRF attack.', { status: 400 })
      }

      if (!code) {
        reject(new Error('No authorization code received'))
        return new Response('Missing authorization code.', { status: 400 })
      }

      resolve(code)
      return new Response('Authentication successful! You may close this tab.')
    }
  })

  callbacks.onAuth({ url: authUrl })

  try {
    const code = await promise
    callbacks.onProgress?.('Exchanging auth code for tokens...')
    const credentials = await exchangeCode(code, fetchFn)
    callbacks.onProgress?.('Discovering Cloud Code project...')
    const projectId = await discoverProject(credentials.access, fetchFn)
    return { ...credentials, projectId }
  } finally {
    clearTimeout(timeout)
    server.stop()
  }
}

let registered = false

export const ensureAntigravityOAuthRegistered = (): void => {
  if (registered) return

  const provider: OAuthProviderInterface = {
    id: 'google-antigravity',
    name: 'Google Antigravity',
    usesCallbackServer: true,

    login: loginAntigravity,

    refreshToken: async (credentials) => {
      const refreshed = await refreshAccessToken(credentials.refresh)
      return { ...refreshed, projectId: credentials.projectId }
    },

    getApiKey: (credentials) =>
      JSON.stringify({ token: credentials.access, projectId: credentials.projectId })
  }

  registerOAuthProvider(provider)
  registered = true
}
