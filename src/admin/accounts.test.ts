import { describe, expect, it, mock } from 'bun:test'
import type { RouterState } from '../state'
import { createState } from '../state'
import { createTelemetryEmitter } from '../telemetry/emitter'
import type { Account, CredentialFile, RouterOptions } from '../types'
import { addAccount, disableAccount, listAccounts, loginAccount, removeAccount } from './accounts'
import { AdminError } from './errors'

const baseOptions = (): RouterOptions => ({
  server: { port: 3000, host: '127.0.0.1' },
  auth: { apiKeys: [] },
  providers: {
    p1: {
      type: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      accounts: [{ type: 'api-key', name: 'existing', key: 'k' }] as Account[],
      balancing: { strategy: 'round-robin' }
    }
  },
  authDir: '/tmp/auth',
  routing: { rules: [], scenarios: {}, default: { provider: 'p1' } },
  telemetry: { level: 'info' }
})

const mkState = (persist?: (o: RouterOptions) => Promise<void>): RouterState =>
  createState(baseOptions(), persist ?? null, createTelemetryEmitter([]))

describe('listAccounts', () => {
  it('flattens accounts across providers', () => {
    const state = mkState()
    const list = listAccounts(state)
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual({
      provider: 'p1',
      account: { type: 'api-key', name: 'existing', key: 'k' }
    })
  })

  it('includes expires when credentials are cached', () => {
    const state = mkState()
    state.credentials.set('existing', {
      provider: 'x',
      refreshToken: 'r',
      accessToken: 'k',
      expires: 1234567890
    })
    expect(listAccounts(state)[0]?.expires).toBe(1234567890)
  })

  it('omits expires when no credentials are cached', () => {
    const state = mkState()
    expect('expires' in listAccounts(state)[0]!).toBe(false)
  })
})

describe('addAccount', () => {
  it('inserts into provider, swaps options, calls persist', async () => {
    const saved: RouterOptions[] = []
    const state = mkState(async (o) => {
      saved.push(o)
    })
    const original = state.options
    await addAccount(state, 'p1', { type: 'api-key', name: 'new', key: 'sk-new' })
    expect(state.options).not.toBe(original)
    expect(state.options.providers.p1?.accounts.map((a) => a.name)).toEqual(['existing', 'new'])
    expect(saved[0]?.providers.p1?.accounts.map((a) => a.name)).toEqual(['existing', 'new'])
  })

  it('throws AdminError on duplicate name', async () => {
    const state = mkState()
    const err = await addAccount(state, 'p1', {
      type: 'api-key',
      name: 'existing',
      key: 'k'
    }).catch((e) => e)
    expect(err).toBeInstanceOf(AdminError)
    expect(err).toMatchObject({ code: 'account_conflict' })
  })

  it('throws AdminError on unknown provider', async () => {
    const state = mkState()
    await expect(
      addAccount(state, 'nope', { type: 'api-key', name: 'x', key: 'k' })
    ).rejects.toMatchObject({
      code: 'provider_not_found'
    })
  })

  it('rejects bodies that fail AccountSchema (missing key on api-key)', async () => {
    const state = mkState()
    await expect(
      addAccount(state, 'p1', { type: 'api-key', name: 'new' } as unknown as Account)
    ).rejects.toThrow()
  })
})

describe('removeAccount', () => {
  it('removes from provider, clears credentials cache, calls persist', async () => {
    let called = false
    const state = mkState(async () => {
      called = true
    })
    state.credentials.set('existing', {
      provider: 'x',
      refreshToken: 'r',
      accessToken: 'k',
      expires: 0
    })
    await removeAccount(state, 'p1', 'existing')
    expect(state.options.providers.p1?.accounts).toHaveLength(0)
    expect(state.credentials.has('existing')).toBe(false)
    expect(called).toBe(true)
  })

  it('throws AdminError when account missing', async () => {
    const state = mkState()
    await expect(removeAccount(state, 'p1', 'nope')).rejects.toMatchObject({
      code: 'account_not_found'
    })
  })
})

describe('disableAccount', () => {
  it('toggles disabled flag and persists', async () => {
    const state = mkState()
    await disableAccount(state, 'p1', 'existing', true)
    expect(state.options.providers.p1?.accounts[0]?.disabled).toBe(true)
    await disableAccount(state, 'p1', 'existing', false)
    expect(state.options.providers.p1?.accounts[0]?.disabled).toBe(false)
  })
})

const codexBaseOptions = (): RouterOptions =>
  ({
    server: { port: 0, host: '127.0.0.1' },
    auth: { apiKeys: [] },
    authDir: `/tmp/pi-route-test-${crypto.randomUUID()}`,
    providers: {
      codex: {
        type: 'openai-codex',
        accounts: [],
        balancing: { strategy: 'fill-first' }
      }
    },
    routing: { rules: [], scenarios: {}, default: { provider: 'codex' } },
    telemetry: { level: 'info' }
  }) as RouterOptions

const fakeState = (): RouterState =>
  ({
    options: codexBaseOptions(),
    credentials: new Map<string, CredentialFile>(),
    timers: new Map(),
    refreshFailures: new Map(),
    persist: null,
    telemetry: { sinks: [], emit: () => {} }
  }) as RouterState

describe('loginAccount: openai-codex-oauth', () => {
  it('dispatches login to pi-ai loginOpenAICodex and persists credentials', async () => {
    const realModule = await import('../auth/openai-codex-oauth')

    const fakeCreds = {
      refresh: 'rt',
      access: 'at',
      expires: Date.now() + 3600_000
    }
    const stub = mock(async () => fakeCreds)

    mock.module('../auth/openai-codex-oauth', () => ({
      loginOpenAICodex: stub
    }))

    try {
      const state = fakeState()
      await addAccount(state, 'codex', { type: 'openai-codex-oauth', name: 'me@example.com' })

      await loginAccount(state, 'codex', 'me@example.com', {
        onAuth: () => {},
        onPrompt: async () => '',
        onProgress: () => {}
      })

      expect(stub).toHaveBeenCalledTimes(1)
      const stored = state.credentials.get('me@example.com')
      expect(stored?.provider).toBe('openai-codex')
      expect(stored?.accessToken).toBe('at')
      expect(stored?.refreshToken).toBe('rt')
    } finally {
      mock.module('../auth/openai-codex-oauth', () => realModule)
    }
  })
})

describe('loginAccount', () => {
  it('throws AdminError when account missing', async () => {
    const state = mkState()
    await expect(
      loginAccount(state, 'p1', 'nope', {
        onAuth: () => {},
        onPrompt: async () => '',
        onProgress: () => {}
      })
    ).rejects.toMatchObject({ code: 'account_not_found' })
  })

  it('maps LoginTimeoutError to AdminError(login_timeout) on abort', async () => {
    const state = createState(
      {
        ...baseOptions(),
        providers: {
          p1: {
            type: 'antigravity',
            baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
            accounts: [{ type: 'antigravity-oauth', name: 'acct' }],
            balancing: { strategy: 'round-robin' }
          }
        }
      },
      null,
      createTelemetryEmitter([])
    )
    const ctl = new AbortController()
    ctl.abort()
    await expect(
      loginAccount(
        state,
        'p1',
        'acct',
        { onAuth: () => {}, onPrompt: async () => '', onProgress: () => {} },
        { signal: ctl.signal }
      )
    ).rejects.toMatchObject({ code: 'login_timeout' })
  })
})
