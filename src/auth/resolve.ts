import { getOAuthProvider } from '@mariozechner/pi-ai/oauth'
import type { RouterState } from '../state'
import type { Account } from '../types'
import { readCredentials, refreshAndStore } from './credentials'

export const resolveKey = async (state: RouterState, account: Account): Promise<string> => {
  if (account.credential === 'key') return account.key

  let cred = state.credentials.get(account.name)
  if (!cred) {
    cred = await readCredentials(state.authDir, account.name)
    state.credentials.set(account.name, cred)
  }

  const provider = getOAuthProvider(cred.provider)
  if (!provider) {
    throw new Error(`OAuth not supported: no provider registered for '${cred.provider}'`)
  }

  if (Date.now() >= cred.expires) {
    cred = await refreshAndStore(state, account)
  }

  // Antigravity supports a per-provider projectId override from router.yaml
  const effective =
    account.projectId !== undefined ? { ...cred, projectId: account.projectId } : cred
  return provider.getApiKey(effective)
}
