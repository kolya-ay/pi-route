import { describe, expect, it, mock } from 'bun:test'
import type { RouterState } from '../state'
import { createState } from '../state'
import { createTel } from '../telemetry/tel'
import type { Account, RouterOptions } from '../types'
import { writeCredentials } from './credentials'
import { resolveKey } from './resolve'

const baseOptions: RouterOptions = {
  providers: {},
  pipeline: [],
  expose: []
}

const mkState = (authDir: string): RouterState =>
  createState(baseOptions, null as never, { accounts: {} }, authDir)

const tel = createTel()

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

    const { registerOAuthProvider, getOAuthProvider } = await import('@mariozechner/pi-ai/oauth')
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
