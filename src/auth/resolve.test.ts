import { describe, expect, it, mock } from 'bun:test'
import { getOAuthProvider, registerOAuthProvider } from '@mariozechner/pi-ai/oauth'
import type { RouterState } from '../state'
import { createState } from '../state'
import { createTel } from '../telemetry/tel'
import type { Account, CredentialFile, RouterOptions } from '../types'
import { readCredentials, writeCredentials } from './credentials'
import { resolveCredential, resolveKey } from './resolve'

const baseOptions: RouterOptions = {
  providers: {},
  pipeline: [],
  expose: []
}

const mkState = (authDir: string): RouterState =>
  createState(baseOptions, null as never, { accounts: {} }, authDir)

const tel = createTel()

describe('resolveCredential', () => {
  it('key credential returns null', async () => {
    const state = mkState('/tmp')
    const account: Account = { credential: 'key', key: 'sk-test' }
    expect(await resolveCredential(state, account, tel)).toBeNull()
  })

  it('oauth account returns cached credentials when present', async () => {
    const state = mkState('/tmp')
    const cached: CredentialFile = {
      provider: 'openai-codex',
      refresh: 'cached-refresh',
      access: 'cached-access',
      expires: Date.now() + 60_000
    }
    const account: Account = { credential: 'oauth', name: 'acct' }
    state.credentials.set(account.name, cached)

    expect(await resolveCredential(state, account, tel)).toEqual(cached)
  })

  it('oauth account loads credentials from disk and stores them in cache', async () => {
    const dir = `/tmp/resolve-${crypto.randomUUID()}`
    const stored: CredentialFile = {
      provider: 'openai-codex',
      refresh: 'disk-refresh',
      access: 'disk-access',
      expires: Date.now() + 60_000
    }
    await writeCredentials(dir, 'acct', stored)
    const state = mkState(dir)
    const account: Account = { credential: 'oauth', name: 'acct' }

    expect(await resolveCredential(state, account, tel)).toEqual(stored)
    expect(state.credentials.get(account.name)).toEqual(stored)
  })

  it('oauth account returns null when the credential file is missing', async () => {
    const dir = `/tmp/resolve-${crypto.randomUUID()}`
    const state = mkState(dir)
    const account: Account = { credential: 'oauth', name: 'missing' }

    await expect(resolveCredential(state, account, tel)).resolves.toBeNull()
  })

  it('oauth account refreshes expired credentials and returns the refreshed credential', async () => {
    const dir = `/tmp/resolve-${crypto.randomUUID()}`
    await writeCredentials(dir, 'acct', {
      provider: 'openai-codex',
      refresh: 'old-r',
      access: 'old-access',
      expires: Date.now() - 1
    })

    const previous = getOAuthProvider('openai-codex')
    if (!previous) throw new Error('openai-codex provider not pre-registered for test')

    const refreshStub = mock(async () => ({
      refresh: 'new-r',
      access: 'new-access',
      expires: Date.now() + 3600_000
    }))
    registerOAuthProvider({ ...previous, refreshToken: refreshStub })

    try {
      const state = mkState(dir)
      const account: Account = { credential: 'oauth', name: 'acct' }
      const result = await resolveCredential(state, account, tel)
      expect(refreshStub).toHaveBeenCalledTimes(1)
      expect(result).toEqual({
        provider: 'openai-codex',
        refresh: 'new-r',
        access: 'new-access',
        expires: expect.any(Number)
      })
      expect(await readCredentials(dir, 'acct')).toEqual({
        provider: 'openai-codex',
        refresh: 'new-r',
        access: 'new-access',
        expires: expect.any(Number)
      })
    } finally {
      registerOAuthProvider(previous)
    }
  })
})

describe('resolveKey', () => {
  it('key credential returns the key field', async () => {
    const state = mkState('/tmp')
    const account: Account = { credential: 'key', key: 'sk-test' }
    expect(await resolveKey(state, account, tel)).toBe('sk-test')
  })

  it('antigravity oauth account returns JSON {token, projectId} using cached non-expired credentials', async () => {
    const dir = `/tmp/resolve-${crypto.randomUUID()}`
    await writeCredentials(dir, 'acct', {
      provider: 'google-antigravity',
      refresh: 'r',
      access: 'access-abc',
      expires: Date.now() + 60_000,
      projectId: 'proj-xyz'
    })
    const state = mkState(dir)
    const account: Account = { credential: 'oauth', name: 'acct' }
    const json = await resolveKey(state, account, tel)
    expect(JSON.parse(json)).toEqual({ token: 'access-abc', projectId: 'proj-xyz' })
  })

  it('openai-codex oauth account returns raw accessToken (not JSON-wrapped) for fresh credentials', async () => {
    const dir = `/tmp/resolve-${crypto.randomUUID()}`
    await writeCredentials(dir, 'acct', {
      provider: 'openai-codex',
      refresh: 'r',
      access: 'raw-access-tok',
      expires: Date.now() + 60_000
    })
    const state = mkState(dir)
    const account: Account = { credential: 'oauth', name: 'acct' }
    const result = await resolveKey(state, account, tel)
    expect(result).toBe('raw-access-tok')
  })

  it('openai-codex oauth account calls registered provider refreshToken and returns refreshed access', async () => {
    const dir = `/tmp/resolve-${crypto.randomUUID()}`
    await writeCredentials(dir, 'acct', {
      provider: 'openai-codex',
      refresh: 'old-r',
      access: 'old-access',
      expires: Date.now() - 1
    })

    const previous = getOAuthProvider('openai-codex')
    if (!previous) throw new Error('openai-codex provider not pre-registered for test')

    const refreshStub = mock(async () => ({
      refresh: 'new-r',
      access: 'new-access',
      expires: Date.now() + 3600_000
    }))
    registerOAuthProvider({ ...previous, refreshToken: refreshStub })

    try {
      const state = mkState(dir)
      const account: Account = { credential: 'oauth', name: 'acct' }
      const result = await resolveKey(state, account, tel)
      expect(refreshStub).toHaveBeenCalledTimes(1)
      expect(result).toBe('new-access')
    } finally {
      // Restore the original (preload-installed) provider
      registerOAuthProvider(previous)
    }
  })
})
