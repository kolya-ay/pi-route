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

const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com'
const DISCOVERY_METADATA = {
  ideType: 'ANTIGRAVITY',
  platform: 'PLATFORM_UNSPECIFIED',
  pluginType: 'GEMINI'
} as const

const ONBOARD_POLL_INTERVAL_MS = 5000
const ONBOARD_POLL_MAX_ATTEMPTS = 10
const DEFAULT_TIER_ID = 'free-tier'

type AllowedTier = { id?: string; isDefault?: boolean }
type CloudCompanionProject = string | { id?: string } | undefined
type LoadCodeAssistResponse = {
  cloudaicompanionProject?: CloudCompanionProject
  allowedTiers?: AllowedTier[]
}
type LroOperation = {
  name?: string
  done?: boolean
  response?: { cloudaicompanionProject?: CloudCompanionProject }
  error?: { message?: string }
}

const extractProjectId = (raw: CloudCompanionProject): string | undefined => {
  if (typeof raw === 'string') return raw
  if (raw && typeof raw === 'object' && typeof raw.id === 'string') return raw.id
  return undefined
}

const callCloudCode = async (
  fetchFn: FetchFn,
  url: string,
  accessToken: string,
  init: { method: 'POST' | 'GET'; body?: unknown }
): Promise<Record<string, unknown>> => {
  const response = await fetchFn(url, {
    method: init.method,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Cloud Code call ${init.method} ${url} failed (${response.status}): ${text}`)
  }
  return (await response.json()) as Record<string, unknown>
}

const loadCodeAssist = (accessToken: string, fetchFn: FetchFn): Promise<LoadCodeAssistResponse> =>
  callCloudCode(fetchFn, `${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`, accessToken, {
    method: 'POST',
    body: { metadata: DISCOVERY_METADATA }
  }) as Promise<LoadCodeAssistResponse>

const onboardUser = (
  accessToken: string,
  tierId: string,
  fetchFn: FetchFn
): Promise<LroOperation> =>
  callCloudCode(fetchFn, `${CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`, accessToken, {
    method: 'POST',
    body: { tierId, metadata: DISCOVERY_METADATA }
  }) as Promise<LroOperation>

const pollOperation = (
  accessToken: string,
  operationName: string,
  fetchFn: FetchFn
): Promise<LroOperation> =>
  callCloudCode(fetchFn, `${CODE_ASSIST_ENDPOINT}/v1internal/${operationName}`, accessToken, {
    method: 'GET'
  }) as Promise<LroOperation>

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const pickTierId = (load: LoadCodeAssistResponse): string =>
  load.allowedTiers?.find((t) => t.isDefault === true)?.id ?? DEFAULT_TIER_ID

const pollUntilDone = async (
  accessToken: string,
  op: LroOperation,
  fetchFn: FetchFn,
  attempt: number,
  onProgress?: (msg: string) => void
): Promise<LroOperation> => {
  if (op.done === true) return op
  if (attempt > ONBOARD_POLL_MAX_ATTEMPTS) {
    throw new Error(
      `Onboarding timed out after ${(ONBOARD_POLL_MAX_ATTEMPTS * ONBOARD_POLL_INTERVAL_MS) / 1000}s; rerun pi-route login to retry`
    )
  }
  if (!op.name) throw new Error('onboardUser response missing operation name')
  onProgress?.(`Waiting for onboarding (${attempt}/${ONBOARD_POLL_MAX_ATTEMPTS})...`)
  await sleep(ONBOARD_POLL_INTERVAL_MS)
  const next = await pollOperation(accessToken, op.name, fetchFn)
  return pollUntilDone(accessToken, next, fetchFn, attempt + 1, onProgress)
}

export const discoverProject = async (
  accessToken: string,
  fetchFn: FetchFn = globalThis.fetch,
  onProgress?: (msg: string) => void
): Promise<string> => {
  const load = await loadCodeAssist(accessToken, fetchFn)
  const direct = extractProjectId(load.cloudaicompanionProject)
  if (direct) return direct

  onProgress?.('Onboarding account...')
  const initial = await onboardUser(accessToken, pickTierId(load), fetchFn)
  const final = await pollUntilDone(accessToken, initial, fetchFn, 1, onProgress)

  if (final.error?.message) throw new Error(`Onboarding failed: ${final.error.message}`)

  const fromLro = extractProjectId(final.response?.cloudaicompanionProject)
  if (fromLro) return fromLro

  onProgress?.('Fetching newly provisioned project...')
  const reload = await loadCodeAssist(accessToken, fetchFn)
  const reloaded = extractProjectId(reload.cloudaicompanionProject)
  if (reloaded) return reloaded

  throw new Error(
    `Onboarding completed but no project found in LRO response or post-onboarding loadCodeAssist. LRO response: ${JSON.stringify(final.response ?? null)}`
  )
}

export class LoginTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LoginTimeoutError'
  }
}

export const loginAntigravity = async (
  callbacks: OAuthLoginCallbacks,
  fetchFn: FetchFn = globalThis.fetch,
  signal?: AbortSignal,
  configuredProjectId?: string
): Promise<OAuthCredentials> => {
  if (signal?.aborted) throw new LoginTimeoutError('OAuth login aborted')

  const state = crypto.randomUUID()
  const authUrl = buildAuthUrl(state)

  const { promise, resolve, reject } = Promise.withResolvers<string>()

  const timeout = setTimeout(
    () => reject(new LoginTimeoutError(`OAuth login timed out after ${LOGIN_TIMEOUT_MS / 1000}s`)),
    LOGIN_TIMEOUT_MS
  )

  const onAbort = () => reject(new LoginTimeoutError('OAuth login aborted'))
  signal?.addEventListener('abort', onAbort, { once: true })

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
    if (configuredProjectId) {
      callbacks.onProgress?.(`Using configured projectId: ${configuredProjectId}`)
      return { ...credentials, projectId: configuredProjectId }
    }
    callbacks.onProgress?.('Discovering Cloud Code project...')
    const projectId = await discoverProject(credentials.access, fetchFn, callbacks.onProgress)
    return { ...credentials, projectId }
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', onAbort)
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
