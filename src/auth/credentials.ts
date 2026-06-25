// src/auth/credentials.ts

import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getOAuthProvider } from '@mariozechner/pi-ai/oauth'
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
  account: Account & { credential: 'oauth' }
): Promise<CredentialFile> => {
  const current =
    state.credentials.get(account.name) ?? (await readCredentials(state.authDir, account.name))
  state.credentials.set(account.name, current)

  try {
    const provider = getOAuthProvider(current.provider)
    if (!provider) {
      throw new Error(`Cannot refresh: no OAuth provider registered for id '${current.provider}'`)
    }
    const refreshed = await provider.refreshToken(current)
    const merged: CredentialFile = { ...current, ...refreshed }
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
