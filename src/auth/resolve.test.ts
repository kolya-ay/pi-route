import { describe, expect, it, mock } from 'bun:test'
import type { RouterState } from '../state'
import { createState } from '../state'
import { createTelemetryEmitter } from '../telemetry/emitter'
import type { Account } from '../types'
import { writeCredentials } from './credentials'
import { resolveKey } from './resolve'

const baseOptions = {
  server: { port: 3000, host: '127.0.0.1' },
  auth: { apiKeys: [] },
  providers: {},
  authDir: '/tmp',
  routing: { rules: [], scenarios: {}, default: { provider: 'p1' } },
  telemetry: { level: 'info' as const }
} as unknown as RouterState['options']

const mkState = (authDir: string): RouterState =>
  createState({ ...baseOptions, authDir }, null, createTelemetryEmitter([]))

describe('resolveKey', () => {
  it('api-key account returns the key field', async () => {
    const state = mkState('/tmp')
    const account: Account = { type: 'api-key', name: 'a', key: 'sk-test' }
    expect(await resolveKey(state, account)).toBe('sk-test')
  })

  it('claude-cli account reads oauthToken from tokenPath', async () => {
    const dir = `/tmp/resolve-${crypto.randomUUID()}`
    const tokenPath = `${dir}/cred.json`
    await Bun.write(tokenPath, JSON.stringify({ oauthToken: 'claude-tok-xyz' }))
    const state = mkState(dir)
    const account: Account = { type: 'claude-cli', name: 'a', tokenPath }
    expect(await resolveKey(state, account)).toBe('claude-tok-xyz')
  })

  it('antigravity-oauth account returns JSON {token, projectId} using cached non-expired credentials', async () => {
    const dir = `/tmp/resolve-${crypto.randomUUID()}`
    await writeCredentials(dir, 'acct', {
      provider: 'google-antigravity',
      refreshToken: 'r',
      accessToken: 'access-abc',
      expires: Date.now() + 60_000,
      projectId: 'proj-xyz'
    })
    const state = mkState(dir)
    const account: Account = { type: 'antigravity-oauth', name: 'acct' }
    const json = await resolveKey(state, account)
    expect(JSON.parse(json)).toEqual({ token: 'access-abc', projectId: 'proj-xyz' })
  })

  it('openai-codex-oauth account returns raw accessToken (not JSON-wrapped) for fresh credentials', async () => {
    const dir = `/tmp/resolve-${crypto.randomUUID()}`
    await writeCredentials(dir, 'acct', {
      provider: 'openai-codex',
      refreshToken: 'r',
      accessToken: 'raw-access-tok',
      expires: Date.now() + 60_000
    })
    const state = mkState(dir)
    const account: Account = { type: 'openai-codex-oauth', name: 'acct' }
    const result = await resolveKey(state, account)
    expect(result).toBe('raw-access-tok')
  })

  it('openai-codex-oauth account calls refreshOpenAICodexToken and returns refreshed token when credentials are expired', async () => {
    const dir = `/tmp/resolve-${crypto.randomUUID()}`
    await writeCredentials(dir, 'acct', {
      provider: 'openai-codex',
      refreshToken: 'old-r',
      accessToken: 'old-access',
      expires: Date.now() - 1
    })

    const realModule = await import('./openai-codex-oauth')
    const stub = mock(async () => ({
      refresh: 'new-r',
      access: 'new-access',
      expires: Date.now() + 3600_000
    }))
    mock.module('./openai-codex-oauth', () => ({ ...realModule, refreshOpenAICodexToken: stub }))

    try {
      const state = mkState(dir)
      const account: Account = { type: 'openai-codex-oauth', name: 'acct' }
      const result = await resolveKey(state, account)
      expect(stub).toHaveBeenCalledTimes(1)
      expect(result).toBe('new-access')
    } finally {
      mock.module('./openai-codex-oauth', () => realModule)
    }
  })
})
