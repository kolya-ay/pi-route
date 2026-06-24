// src/auth/credentials.ts

import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { RouterState } from '../state'
import type { Account, CredentialFile, ProviderType } from '../types'

export type { CredentialFile } from '../types'

export const readCredentials = async (
  authDir: string,
  accountName: string
): Promise<CredentialFile> => {
  const file = Bun.file(join(authDir, `${accountName}.json`))
  if (!(await file.exists())) {
    throw new Error(`Credential file not found: ${join(authDir, `${accountName}.json`)}`)
  }
  return file.json() as Promise<CredentialFile>
}

export const writeCredentials = async (
  authDir: string,
  accountName: string,
  credentials: CredentialFile
): Promise<void> => {
  mkdirSync(authDir, { recursive: true, mode: 0o700 })
  const path = join(authDir, `${accountName}.json`)
  await Bun.write(path, JSON.stringify(credentials, null, 2))
  chmodSync(path, 0o600)
}

export const refreshAndStore = async (
  state: RouterState,
  account: Account & { credential: 'oauth' },
  providerType: ProviderType
): Promise<CredentialFile> => {
  if (providerType !== 'antigravity' && providerType !== 'openai-codex') {
    throw new Error(`Cannot refresh provider type '${providerType}'`)
  }
  const current =
    state.credentials.get(account.name) ?? (await readCredentials(state.authDir, account.name))
  state.credentials.set(account.name, current)

  try {
    const { refresh, access, expires, providerLabel } = await dispatchRefresh(providerType, current)
    const merged: CredentialFile = {
      ...current,
      provider: providerLabel,
      refreshToken: refresh,
      accessToken: access,
      expires
    }
    await writeCredentials(state.authDir, account.name, merged)
    state.credentials.set(account.name, merged)
    state.telemetry.emit({
      type: 'account.refreshed',
      account: account.name,
      expires: merged.expires
    })
    return merged
  } catch (err) {
    state.telemetry.emit({
      type: 'account.refresh-failed',
      account: account.name,
      error: err instanceof Error ? err.message : String(err)
    })
    throw err
  }
}

type RefreshResult = { refresh: string; access: string; expires: number; providerLabel: string }

const dispatchRefresh = async (
  providerType: ProviderType,
  current: CredentialFile
): Promise<RefreshResult> => {
  if (providerType === 'antigravity') {
    const { refreshAccessToken } = await import('./antigravity-oauth')
    const r = await refreshAccessToken(current.refreshToken)
    return {
      refresh: r.refresh,
      access: r.access,
      expires: r.expires,
      providerLabel: 'google-antigravity'
    }
  }
  if (providerType === 'openai-codex') {
    const { refreshOpenAICodexToken } = await import('./openai-codex-oauth')
    const r = await refreshOpenAICodexToken(current.refreshToken)
    return {
      refresh: r.refresh,
      access: r.access,
      expires: r.expires,
      providerLabel: 'openai-codex'
    }
  }
  throw new Error(`Cannot dispatch refresh for provider type '${providerType}'`)
}
