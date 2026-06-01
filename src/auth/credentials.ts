// src/auth/credentials.ts

import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { RouterState } from '../state'
import type { Account, CredentialFile } from '../types'

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
  account: Account
): Promise<CredentialFile> => {
  if (account.type !== 'antigravity-oauth') {
    throw new Error(`Cannot refresh account of type '${account.type}'`)
  }
  const current =
    state.credentials.get(account.name) ??
    (await readCredentials(state.options.authDir, account.name))
  state.credentials.set(account.name, current)

  try {
    const { refreshAccessToken } = await import('./antigravity-oauth')
    const refreshed = await refreshAccessToken(current.refreshToken)
    // Preserve fields refresh() doesn't set (e.g. projectId).
    const merged: CredentialFile = {
      ...current,
      provider: 'google-antigravity',
      refreshToken: refreshed.refresh,
      accessToken: refreshed.access,
      expires: refreshed.expires
    }
    await writeCredentials(state.options.authDir, account.name, merged)
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
