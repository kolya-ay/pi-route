import { getOAuthProvider } from '@mariozechner/pi-ai/oauth'
import type { RouterState } from '../state'
import type { Tel } from '../telemetry/tel'
import type { Account, CredentialFile } from '../types'
import { readCredentials, refreshAndStore } from './credentials'

export const resolveCredential = async (
  state: RouterState,
  account: Account,
  tel: Tel
): Promise<CredentialFile | null> => {
  if (account.credential === 'key') return null

  let cred = state.credentials.get(account.name)
  if (!cred) {
    try {
      cred = await readCredentials(state.authDir, account.name)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Credential file not found:')) {
        return null
      }
      throw error
    }
    state.credentials.set(account.name, cred)
  }

  if (Date.now() >= cred.expires) {
    cred = await refreshAndStore(state, account, tel)
    state.credentials.set(account.name, cred)
  }

  return cred
}

export const resolveKey = async (
  state: RouterState,
  account: Account,
  tel: Tel
): Promise<string> => {
  if (account.credential === 'key') return account.key

  const cred = await resolveCredential(state, account, tel)
  if (!cred) {
    throw new Error(`OAuth credential required for account '${account.name}'`)
  }

  const provider = getOAuthProvider(cred.provider)
  if (!provider) {
    throw new Error(`OAuth not supported: no provider registered for '${cred.provider}'`)
  }

  const effective =
    account.projectId !== undefined ? { ...cred, projectId: account.projectId } : cred
  return provider.getApiKey(effective)
}
