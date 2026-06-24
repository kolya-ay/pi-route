import { homedir } from 'node:os'
import { join } from 'node:path'
import type { RouterState } from '../state'
import type { Account, ProviderType } from '../types'
import { readCredentials, refreshAndStore } from './credentials'

const expandHome = (p: string): string => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)

export const resolveKey = async (
  state: RouterState,
  account: Account,
  providerType: ProviderType
): Promise<string> => {
  if (account.credential === 'key') return account.key

  if (account.credential === 'file') {
    const parsed = JSON.parse(await Bun.file(expandHome(account.path)).text()) as {
      oauthToken: string
    }
    return parsed.oauthToken
  }

  // OAuth: dispatch by providerType
  if (providerType === 'antigravity') {
    let cred = state.credentials.get(account.name)
    if (!cred) {
      cred = await readCredentials(state.authDir, account.name)
      state.credentials.set(account.name, cred)
    }
    if (Date.now() >= cred.expires) {
      cred = await refreshAndStore(state, account, providerType)
    }
    return JSON.stringify({
      token: cred.accessToken,
      projectId: account.projectId ?? cred.projectId
    })
  }

  if (providerType === 'openai-codex') {
    let cred = state.credentials.get(account.name)
    if (!cred) {
      cred = await readCredentials(state.authDir, account.name)
      state.credentials.set(account.name, cred)
    }
    if (Date.now() >= cred.expires) {
      cred = await refreshAndStore(state, account, providerType)
    }
    return cred.accessToken
  }

  throw new Error(`OAuth not supported for provider type "${providerType}"`)
}
