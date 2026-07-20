import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { RouterOptions } from '../types'

// Can this provider serve a request right now? Key credentials are always
// present — an unresolved `$VAR` already throws at config load — so this only
// ever excludes disabled accounts and OAuth providers with no credential file.
export const isAvailable = (options: RouterOptions, authDir: string, name: string): boolean => {
  const provider = options.providers[name]
  if (!provider || provider.account.disabled === true) return false
  if (provider.account.credential !== 'oauth') return true
  return existsSync(join(authDir, `${provider.account.name}.json`))
}

export const availableProviders = (options: RouterOptions, authDir: string): Set<string> =>
  new Set(Object.keys(options.providers).filter((name) => isAvailable(options, authDir, name)))
