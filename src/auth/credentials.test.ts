// src/auth/credentials.test.ts

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createState } from '../state'
import { createTel } from '../telemetry/tel'
import { useTestExporter } from '../telemetry/test-fixture'
import type { CredentialFile, RouterOptions } from '../types'
import { readCredentials, refreshAndStore, writeCredentials } from './credentials'

const mkState = (authDir: string) =>
  createState({} as RouterOptions, null as never, { accounts: {} }, authDir)

const exporter = useTestExporter()

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `credentials-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('readCredentials', () => {
  it('reads an existing credential file', async () => {
    const cred: CredentialFile = {
      provider: 'google-antigravity',
      refresh: 'ref-token',
      access: 'acc-token',
      expires: 9999999999999,
      projectId: 'my-project'
    }
    await writeCredentials(testDir, 'test-account', cred)

    const result = await readCredentials(testDir, 'test-account')
    expect(result.provider).toBe('google-antigravity')
    expect(result.refresh).toBe('ref-token')
    expect(result.access).toBe('acc-token')
    expect(result.expires).toBe(9999999999999)
    expect(result.projectId).toBe('my-project')
  })

  it('renames legacy accessToken/refreshToken keys on read', async () => {
    const legacy = {
      provider: 'openai-codex',
      refreshToken: 'leg-ref',
      accessToken: 'leg-acc',
      expires: 9999999999999
    }
    await Bun.write(join(testDir, 'legacy.json'), JSON.stringify(legacy))

    const result = (await readCredentials(testDir, 'legacy')) as Record<string, unknown>
    expect(result.access).toBe('leg-acc')
    expect(result.refresh).toBe('leg-ref')
    expect(result.accessToken).toBeUndefined()
    expect(result.refreshToken).toBeUndefined()
    expect(result.provider).toBe('openai-codex')
    expect(result.expires).toBe(9999999999999)
  })

  it('throws when file does not exist', async () => {
    await expect(readCredentials(testDir, 'nonexistent')).rejects.toThrow()
  })
})

describe('writeCredentials', () => {
  it('creates the file with pretty-printed JSON', async () => {
    const cred: CredentialFile = {
      provider: 'test-provider',
      refresh: 'r',
      access: 'a',
      expires: 1000
    }
    await writeCredentials(testDir, 'my-account', cred)

    const content = await Bun.file(join(testDir, 'my-account.json')).text()
    const parsed = JSON.parse(content)
    expect(parsed.provider).toBe('test-provider')
    // pretty-printed: should have newlines and indentation
    expect(content).toContain('\n')
    expect(content).toContain('  ')
  })

  it('creates nested directories if they do not exist', async () => {
    const nestedDir = join(testDir, 'nested', 'deep')
    const cred: CredentialFile = { provider: 'p', refresh: 'r', access: 'a', expires: 0 }
    await writeCredentials(nestedDir, 'acct', cred)

    const result = await readCredentials(nestedDir, 'acct')
    expect(result.provider).toBe('p')
  })
})

describe('refreshAndStore', () => {
  it('reads existing credentials, calls refresh, writes back, updates cache', async () => {
    const testDir = `${require('node:os').tmpdir()}/refresh-${crypto.randomUUID()}`
    await writeCredentials(testDir, 'acct', {
      provider: 'google-antigravity',
      refresh: 'old-refresh',
      access: 'old-access',
      expires: Date.now() - 1000,
      projectId: 'proj-123'
    })

    const state = mkState(testDir)
    const credentials = state.credentials

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url, init) => {
      const body = (init as RequestInit).body as string
      if (body.includes('grant_type=refresh_token')) {
        return new Response(
          JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 3600
          }),
          { status: 200 }
        )
      }
      throw new Error(`unexpected fetch: ${_url}`)
    }) as typeof fetch

    try {
      const tel = createTel()
      const result = await tel.withSpan('test.refresh', {}, async () =>
        refreshAndStore(state, { credential: 'oauth', name: 'acct' }, tel)
      )
      expect(result.access).toBe('new-access')
      expect(result.refresh).toBe('new-refresh')
      expect(result.projectId).toBe('proj-123') // preserved
      expect(credentials.get('acct')?.access).toBe('new-access')
      const refreshedEvents = exporter
        .getFinishedSpans()
        .flatMap((s) => s.events)
        .filter((e) => e.name === 'account.refreshed')
      expect(refreshedEvents.length).toBeGreaterThan(0)

      const onDisk = await readCredentials(testDir, 'acct')
      expect(onDisk.access).toBe('new-access')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rethrows on refresh error (account.refresh.failed is emitted by scheduler, not here)', async () => {
    const testDir = `${require('node:os').tmpdir()}/refresh-${crypto.randomUUID()}`
    await writeCredentials(testDir, 'acct', {
      provider: 'google-antigravity',
      refresh: 'bad',
      access: 'old',
      expires: 0
    })

    const state = mkState(testDir)

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400
      })) as unknown as typeof fetch

    try {
      const tel = createTel()
      await expect(
        tel.withSpan('test.refresh', {}, async () =>
          refreshAndStore(state, { credential: 'oauth', name: 'acct' }, tel)
        )
      ).rejects.toThrow()
      // account.refresh.failed is now emitted by scheduler.ts, not credentials.ts.
      const failedEvents = exporter
        .getFinishedSpans()
        .flatMap((s) => s.events)
        .filter((e) => e.name === 'account.refresh.failed')
      expect(failedEvents.length).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// Build a fake JWT with the accountId claim that pi-ai's refreshOpenAICodexToken expects.
// The claim path is https://api.openai.com/auth → chatgpt_account_id.
const makeCodexJwt = (accountId: string): string => {
  const payload = { 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }
  const enc = (v: unknown) => btoa(JSON.stringify(v))
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`
}

describe('refreshAndStore: openai-codex-oauth', () => {
  it('refreshes via pi-ai for an openai-codex-oauth account', async () => {
    const account: import('../types').Account & { credential: 'oauth' } = {
      credential: 'oauth',
      name: 'me@example.com'
    }
    const state = mkState(testDir)
    const existing: CredentialFile = {
      provider: 'openai-codex',
      refresh: 'old-refresh',
      access: 'old-access',
      expires: Date.now() - 1000
    }
    state.credentials.set(account.name, existing)

    const newAccess = makeCodexJwt('acct-123')
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url, init) => {
      const body = (init as RequestInit).body?.toString() ?? ''
      if (body.includes('grant_type=refresh_token') && body.includes('old-refresh')) {
        return new Response(
          JSON.stringify({
            access_token: newAccess,
            refresh_token: 'new-refresh',
            expires_in: 3600
          }),
          { status: 200 }
        )
      }
      throw new Error(`unexpected fetch: ${_url}`)
    }) as typeof fetch

    try {
      const tel = createTel()
      const merged = await refreshAndStore(state, account, tel)
      expect(merged.refresh).toBe('new-refresh')
      expect(merged.access).toBe(newAccess)
      expect(merged.provider).toBe('openai-codex')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
