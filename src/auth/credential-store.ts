// src/auth/credential-store.ts

import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type {
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredential
} from '@earendil-works/pi-ai'
import type { RouterOptions } from '../types'

const oauthName = (options: RouterOptions, providerId: string): string | undefined => {
  const account = options.providers[providerId]?.account
  return account?.credential === 'oauth' ? account.name : undefined
}

const readFile = async (
  dir: string,
  name: string
): Promise<Record<string, unknown> | undefined> => {
  try {
    const file = Bun.file(join(dir, `${name}.json`))
    if (!(await file.exists())) return undefined
    const raw = (await file.json()) as Record<string, unknown>
    if (raw.accessToken !== undefined && raw.access === undefined) raw.access = raw.accessToken
    if (raw.refreshToken !== undefined && raw.refresh === undefined) raw.refresh = raw.refreshToken
    delete raw.accessToken
    delete raw.refreshToken
    return raw
  } catch {
    return undefined
  }
}

const writeFile = async (
  dir: string,
  name: string,
  data: Record<string, unknown>
): Promise<void> => {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${name}.json`)
  await Bun.write(path, JSON.stringify(data, null, 2))
  chmodSync(path, 0o600)
}

// pi-ai CredentialStore over pi-route's per-account XDG credential files.
// Key providers resolve straight from config; oauth providers map providerId
// → account name → <authDir>/<name>.json, preserving the on-disk shape
// (`provider` field, extras like projectId) so pre-migration files stay valid.
export const fileCredentialStore = (authDir: string, options: RouterOptions): CredentialStore => {
  const locks = new Map<string, Promise<unknown>>()
  const serialize = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const next = (locks.get(id) ?? Promise.resolve()).then(fn, fn)
    locks.set(
      id,
      next.catch(() => undefined)
    )
    return next
  }

  const read = async (providerId: string): Promise<Credential | undefined> => {
    const account = options.providers[providerId]?.account
    if (!account) return undefined
    // A disabled account's secret must not leave the store, even to a caller that
    // bypasses the dispatch gate. Login writes a fresh credential and does not rely
    // on reading the old one, so re-enabling is unaffected.
    if (account.disabled === true) return undefined
    if (account.credential === 'key') return { type: 'api_key', key: account.key }
    const raw = await readFile(authDir, account.name)
    if (!raw) return undefined
    const { provider: _provider, ...rest } = raw
    return { type: 'oauth', ...rest } as OAuthCredential
  }

  return {
    read,
    async list(): Promise<readonly CredentialInfo[]> {
      return Object.entries(options.providers).map(([providerId, config]) => ({
        providerId,
        type: config.account.credential === 'key' ? 'api_key' : 'oauth'
      }))
    },
    modify(providerId, fn) {
      return serialize(providerId, async () => {
        const current = await read(providerId)
        const next = await fn(current)
        if (next === undefined) return current
        const name = oauthName(options, providerId)
        if (name && next.type === 'oauth') {
          const existing = (await readFile(authDir, name)) ?? {}
          const { type: _type, ...data } = next
          await writeFile(authDir, name, { ...existing, ...data })
        }
        return next
      })
    },
    async delete(providerId) {
      const name = oauthName(options, providerId)
      if (name) rmSync(join(authDir, `${name}.json`), { force: true })
    }
  }
}
