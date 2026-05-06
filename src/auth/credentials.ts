// src/auth/credentials.ts

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type CredentialFile = {
  provider: string
  refreshToken: string
  accessToken: string
  expires: number
  [key: string]: unknown
}

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
  await Bun.write(path, JSON.stringify(credentials, null, 2), { mode: 0o600 })
}

export const createOAuthResolveKey = (
  authDir: string,
  accountName: string,
  refreshFn: (refreshToken: string) => Promise<CredentialFile>
): (() => Promise<string>) => {
  let cached: CredentialFile | null = null

  return async () => {
    if (!cached) {
      cached = await readCredentials(authDir, accountName)
    }

    if (Date.now() >= cached.expires) {
      const refreshed = await refreshFn(cached.refreshToken)
      await writeCredentials(authDir, accountName, refreshed)
      cached = refreshed
    }

    return JSON.stringify({ token: cached.accessToken, projectId: cached.projectId })
  }
}
