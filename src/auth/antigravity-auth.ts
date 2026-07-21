// src/auth/antigravity-auth.ts
//
// Google Antigravity OAuth ported onto pi-ai's `OAuthAuth` interface. CLI-only:
// `login` runs a localhost callback server (Bun.serve) racing a manual-code
// prompt. The pure parts — URL construction, token exchange, project discovery
// — take an injected `fetchFn` so they stay unit-testable.

import type { AuthInteraction, ModelAuth, OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai'

import { FETCH_TIMEOUT_MS } from '../models/remote-catalog'

// A narrower fetch than `typeof fetch` (mirrors remote-catalog.ts): Bun's mocks
// and bare `async () => Response` are assignable without the `preconnect` prop.
type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

const decode = (s: string) => atob(s)
export const CLIENT_ID = decode(
  'MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ=='
)
export const CLIENT_SECRET = decode('R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=')

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
// Treat a token as expired 5 minutes early so in-flight requests never race the
// real expiry.
const EXPIRY_SKEW_MS = 5 * 60 * 1000

const mintExpiry = (expiresIn: number | undefined): number =>
  Date.now() + (expiresIn ?? 3600) * 1000 - EXPIRY_SKEW_MS

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
  fetchFn: FetchFn
): Promise<{ access: string; refresh: string; expires: number }> => {
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
    expires: mintExpiry(data.expires_in as number | undefined)
  }
}

// --- Project discovery (loadCodeAssist / onboardUser / LRO polling) ---

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
  init: { method: 'POST' | 'GET'; body?: unknown },
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<Record<string, unknown>> => {
  const response = await fetchFn(url, {
    method: init.method,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Cloud Code call ${init.method} ${url} failed (${response.status}): ${text}`)
  }
  return (await response.json()) as Record<string, unknown>
}

const loadCodeAssist = (
  accessToken: string,
  fetchFn: FetchFn,
  timeoutMs: number
): Promise<LoadCodeAssistResponse> =>
  callCloudCode(
    fetchFn,
    `${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`,
    accessToken,
    { method: 'POST', body: { metadata: DISCOVERY_METADATA } },
    timeoutMs
  ) as Promise<LoadCodeAssistResponse>

const onboardUser = (
  accessToken: string,
  tierId: string,
  fetchFn: FetchFn,
  timeoutMs: number
): Promise<LroOperation> =>
  callCloudCode(
    fetchFn,
    `${CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`,
    accessToken,
    { method: 'POST', body: { tierId, metadata: DISCOVERY_METADATA } },
    timeoutMs
  ) as Promise<LroOperation>

const pollOperation = (
  accessToken: string,
  operationName: string,
  fetchFn: FetchFn,
  timeoutMs: number
): Promise<LroOperation> =>
  callCloudCode(
    fetchFn,
    `${CODE_ASSIST_ENDPOINT}/v1internal/${operationName}`,
    accessToken,
    { method: 'GET' },
    timeoutMs
  ) as Promise<LroOperation>

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const pickTierId = (load: LoadCodeAssistResponse): string =>
  load.allowedTiers?.find((t) => t.isDefault === true)?.id ?? DEFAULT_TIER_ID

const pollUntilDone = async (
  accessToken: string,
  op: LroOperation,
  fetchFn: FetchFn,
  attempt: number,
  timeoutMs: number,
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
  const next = await pollOperation(accessToken, op.name, fetchFn, timeoutMs)
  return pollUntilDone(accessToken, next, fetchFn, attempt + 1, timeoutMs, onProgress)
}

export const discoverProject = async (
  accessToken: string,
  fetchFn: FetchFn,
  onProgress?: (msg: string) => void,
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<string> => {
  const load = await loadCodeAssist(accessToken, fetchFn, timeoutMs)
  const direct = extractProjectId(load.cloudaicompanionProject)
  if (direct) return direct

  onProgress?.('Onboarding account...')
  const initial = await onboardUser(accessToken, pickTierId(load), fetchFn, timeoutMs)
  const final = await pollUntilDone(accessToken, initial, fetchFn, 1, timeoutMs, onProgress)

  if (final.error?.message) throw new Error(`Onboarding failed: ${final.error.message}`)

  const fromLro = extractProjectId(final.response?.cloudaicompanionProject)
  if (fromLro) return fromLro

  onProgress?.('Fetching newly provisioned project...')
  const reload = await loadCodeAssist(accessToken, fetchFn, timeoutMs)
  const reloaded = extractProjectId(reload.cloudaicompanionProject)
  if (reloaded) return reloaded

  throw new Error(
    `Onboarding completed but no project found in LRO response or post-onboarding loadCodeAssist. LRO response: ${JSON.stringify(final.response ?? null)}`
  )
}

// --- Login / refresh / toAuth wired onto OAuthAuth ---

// Non-recoverable refresh failures: the stored refresh token is dead, so a retry
// with the same token cannot succeed. Network/5xx are recoverable and rethrown
// plainly so Models keeps the credential and retries later.
const isDefinitiveFailure = (status: number, body: string): boolean =>
  status === 401 || status === 403 || /invalid_grant|invalid_token|revoked/.test(body)

const login =
  (fetchFn: FetchFn) =>
  async (interaction: AuthInteraction): Promise<OAuthCredential> => {
    if (interaction.signal?.aborted) throw new Error('antigravity login aborted')

    const state = crypto.randomUUID()
    const authUrl = buildAuthUrl(state)

    const { promise: codePromise, resolve, reject } = Promise.withResolvers<string>()
    const manualAbort = new AbortController()

    const timeout = setTimeout(
      () => reject(new Error(`OAuth login timed out after ${LOGIN_TIMEOUT_MS / 1000}s`)),
      LOGIN_TIMEOUT_MS
    )
    const onAbort = () => reject(new Error('antigravity login aborted'))
    interaction.signal?.addEventListener('abort', onAbort, { once: true })

    const server = Bun.serve({
      port: CALLBACK_PORT,
      hostname: 'localhost',
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname !== '/oauth-callback') return new Response('Not found', { status: 404 })

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

    interaction.notify({ type: 'auth_url', url: authUrl })

    // Race the callback server against a manual paste — first winner supplies the
    // code. The prompt is aborted (below) once either side settles.
    interaction
      .prompt({
        type: 'manual_code',
        message: 'Complete login in your browser, or paste the authorization code here:',
        signal: manualAbort.signal
      })
      .then((input) => resolve(input.trim()))
      .catch(() => {})

    try {
      const code = await codePromise
      interaction.notify({ type: 'progress', message: 'Exchanging auth code for tokens...' })
      const credentials = await exchangeCode(code, fetchFn)
      interaction.notify({ type: 'progress', message: 'Discovering Cloud Code project...' })
      const projectId = await discoverProject(credentials.access, fetchFn, (message) =>
        interaction.notify({ type: 'progress', message })
      )
      return { type: 'oauth', ...credentials, projectId }
    } finally {
      clearTimeout(timeout)
      interaction.signal?.removeEventListener('abort', onAbort)
      manualAbort.abort()
      server.stop()
    }
  }

const refresh =
  (fetchFn: FetchFn, timeoutMs: number = FETCH_TIMEOUT_MS) =>
  async (credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential> => {
    const projectId = credential.projectId
    if (!projectId) {
      throw new Error('antigravity credential is missing projectId; rerun login to re-provision it')
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credential.refresh,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    })

    const timeout = AbortSignal.timeout(timeoutMs)
    const response = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    })

    if (!response.ok) {
      const text = await response.text()
      if (isDefinitiveFailure(response.status, text)) {
        throw new Error(`antigravity refresh definitively failed: ${text}`)
      }
      throw new Error(`antigravity refresh failed (${response.status}): ${text}`)
    }

    const data = (await response.json()) as Record<string, unknown>

    return {
      type: 'oauth',
      access: data.access_token as string,
      refresh: (data.refresh_token as string | undefined) ?? credential.refresh,
      expires: mintExpiry(data.expires_in as number | undefined),
      projectId
    }
  }

// Pseudo-header carrying the Cloud Code projectId from the stored credential to
// `streamAntigravity` (pi-ai's auth path only forwards apiKey/headers/baseUrl).
// The provider consumes it for the request envelope; it is never sent upstream.
export const PROJECT_HEADER = 'x-pi-route-antigravity-project'

const toAuth = async (credential: OAuthCredential): Promise<ModelAuth> => ({
  apiKey: credential.access,
  ...(typeof credential.projectId === 'string'
    ? { headers: { [PROJECT_HEADER]: credential.projectId } }
    : {})
})

export const antigravityOAuth = (opts: { fetchFn?: FetchFn; timeoutMs?: number }): OAuthAuth => {
  const fetchFn = opts.fetchFn ?? globalThis.fetch
  return {
    name: 'Google Antigravity',
    login: login(fetchFn),
    refresh: refresh(fetchFn, opts.timeoutMs),
    toAuth
  }
}
