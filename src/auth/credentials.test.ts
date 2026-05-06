// src/auth/credentials.test.ts

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { createOAuthResolveKey, readCredentials, writeCredentials } from './credentials'
import type { CredentialFile } from './credentials'

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
    expect(result['projectId']).toBe('my-project')
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

describe('createOAuthResolveKey', () => {
  it('returns cached token when not expired', async () => {
    const cred: CredentialFile = {
      provider: 'google-antigravity',
      refreshToken: 'old-refresh',
      accessToken: 'fresh-access',
      expires: Date.now() + 60_000,
      projectId: 'proj-123'
    }
    await writeCredentials(testDir, 'acct', cred)

    let refreshCalled = 0
    const refreshFn = async (_refreshToken: string): Promise<CredentialFile> => {
      refreshCalled++
      return { ...cred, accessToken: 'new-access', expires: Date.now() + 3600_000 }
    }

    const resolveKey = createOAuthResolveKey(testDir, 'acct', refreshFn)
    const key1 = await resolveKey()
    const key2 = await resolveKey()

    expect(refreshCalled).toBe(0)
    const parsed = JSON.parse(key1)
    expect(parsed.token).toBe('fresh-access')
    expect(parsed.projectId).toBe('proj-123')
    expect(key1).toBe(key2)
  })

  it('refreshes and writes back when token is expired', async () => {
    const cred: CredentialFile = {
      provider: 'google-antigravity',
      refreshToken: 'stale-refresh',
      accessToken: 'stale-access',
      expires: Date.now() - 1000,
      projectId: 'proj-456'
    }
    await writeCredentials(testDir, 'acct', cred)

    const newExpires = Date.now() + 3600_000
    const refreshFn = async (refreshToken: string): Promise<CredentialFile> => {
      expect(refreshToken).toBe('stale-refresh')
      return {
        ...cred,
        accessToken: 'refreshed-access',
        refreshToken: 'new-refresh',
        expires: newExpires
      }
    }

    const resolveKey = createOAuthResolveKey(testDir, 'acct', refreshFn)
    const key = await resolveKey()

    const parsed = JSON.parse(key)
    expect(parsed.token).toBe('refreshed-access')
    expect(parsed.projectId).toBe('proj-456')

    // verify written back to disk
    const saved = await readCredentials(testDir, 'acct')
    expect(saved.accessToken).toBe('refreshed-access')
    expect(saved.refreshToken).toBe('new-refresh')
    expect(saved.expires).toBe(newExpires)
  })
})
