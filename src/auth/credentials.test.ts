// src/auth/credentials.test.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Account } from '../types.js'
import { resolveApiKey } from './credentials.js'

describe('resolveApiKey', () => {
  it('returns key for api-key account', () => {
    const account: Account = { type: 'api-key', name: 'test', key: 'sk-abc123' }
    expect(resolveApiKey(account)).toBe('sk-abc123')
  })

  it('reads oauth token from claude-cli token path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'credentials-test-'))
    const credPath = join(dir, 'credentials.json')
    writeFileSync(credPath, JSON.stringify({ oauthToken: 'claude-oauth-token-xyz' }))

    const account: Account = { type: 'claude-cli', name: 'claude', tokenPath: credPath }
    expect(resolveApiKey(account)).toBe('claude-oauth-token-xyz')
  })

  it('returns access token for oauth account', () => {
    const account: Account = {
      type: 'anthropic-oauth',
      name: 'anthropic',
      credentials: { refresh: 'refresh-tok', access: 'access-tok', expires: 9999999999 },
    }
    expect(resolveApiKey(account)).toBe('access-tok')
  })

  it('throws for oauth account without credentials', () => {
    const account: Account = { type: 'copilot-oauth', name: 'copilot' }
    expect(() => resolveApiKey(account)).toThrow(
      "No credentials available for OAuth account 'copilot'",
    )
  })
})
