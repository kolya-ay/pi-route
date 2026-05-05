// src/auth/credentials.ts

import { readFileSync } from 'node:fs'
import type { Account } from '../types.js'

const oauthTypes = [
  'anthropic-oauth',
  'copilot-oauth',
  'codex-oauth',
  'antigravity-oauth',
] as const

type OAuthType = (typeof oauthTypes)[number]

const isOAuthType = (type: string): type is OAuthType =>
  (oauthTypes as readonly string[]).includes(type)

export const resolveApiKey = (account: Account): string => {
  if (account.type === 'api-key') {
    return account.key
  }

  if (account.type === 'claude-cli') {
    const raw = readFileSync(account.tokenPath, 'utf-8')
    const parsed = JSON.parse(raw) as { oauthToken: string }
    return parsed.oauthToken
  }

  if (isOAuthType(account.type)) {
    if (!account.credentials) {
      throw new Error(`No credentials available for OAuth account '${account.name}'`)
    }
    return account.credentials.access
  }

  throw new Error(`Unknown account type: ${(account as Account).type}`)
}
