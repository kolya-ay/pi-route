// src/auth/credentials.test.ts

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createState } from '../state'
import { createTelemetryEmitter } from '../telemetry/emitter'
import type { CredentialFile, RouterOptions, TelemetryEvent } from '../types'
import { readCredentials, refreshAndStore, writeCredentials } from './credentials'

const mkState = (authDir: string, events: TelemetryEvent[] = []) => {
  const telemetry = createTelemetryEmitter([{ emit: (e) => events.push(e) }])
  return createState({ authDir } as RouterOptions, null, telemetry)
}

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
      refreshToken: 'ref-token',
      accessToken: 'acc-token',
      expires: 9999999999999,
      projectId: 'my-project'
    }
    await writeCredentials(testDir, 'test-account', cred)

    const result = await readCredentials(testDir, 'test-account')
    expect(result.provider).toBe('google-antigravity')
    expect(result.refreshToken).toBe('ref-token')
    expect(result.accessToken).toBe('acc-token')
    expect(result.expires).toBe(9999999999999)
    expect(result.projectId).toBe('my-project')
  })

  it('throws when file does not exist', async () => {
    await expect(readCredentials(testDir, 'nonexistent')).rejects.toThrow()
  })
})

describe('writeCredentials', () => {
  it('creates the file with pretty-printed JSON', async () => {
    const cred: CredentialFile = {
      provider: 'test-provider',
      refreshToken: 'r',
      accessToken: 'a',
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
    const cred: CredentialFile = { provider: 'p', refreshToken: 'r', accessToken: 'a', expires: 0 }
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
      refreshToken: 'old-refresh',
      accessToken: 'old-access',
      expires: Date.now() - 1000,
      projectId: 'proj-123'
    })

    const events: TelemetryEvent[] = []
    const state = mkState(testDir, events)
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
      const result = await refreshAndStore(state, { type: 'antigravity-oauth', name: 'acct' })
      expect(result.accessToken).toBe('new-access')
      expect(result.refreshToken).toBe('new-refresh')
      expect(result.projectId).toBe('proj-123') // preserved
      expect(credentials.get('acct')?.accessToken).toBe('new-access')
      expect(events).toHaveLength(1)
      expect(events[0]?.type).toBe('account.refreshed')

      const onDisk = await readCredentials(testDir, 'acct')
      expect(onDisk.accessToken).toBe('new-access')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('emits account.refresh-failed and rethrows on refresh error', async () => {
    const testDir = `${require('node:os').tmpdir()}/refresh-${crypto.randomUUID()}`
    await writeCredentials(testDir, 'acct', {
      provider: 'google-antigravity',
      refreshToken: 'bad',
      accessToken: 'old',
      expires: 0
    })

    const events: TelemetryEvent[] = []
    const state = mkState(testDir, events)

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400
      })) as unknown as typeof fetch

    try {
      await expect(
        refreshAndStore(state, { type: 'antigravity-oauth', name: 'acct' })
      ).rejects.toThrow()
      expect(events[0]?.type).toBe('account.refresh-failed')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
