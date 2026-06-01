import type { RouterState } from '../state'
import type { Account, AntigravityOAuthAccount } from '../types'
import { readCredentials, refreshAndStore } from './credentials'

const resolveOAuthKey = async (
  state: RouterState,
  account: AntigravityOAuthAccount
): Promise<string> => {
  let cred = state.credentials.get(account.name)
  if (!cred) {
    cred = await readCredentials(state.options.authDir, account.name)
    state.credentials.set(account.name, cred)
  }
  if (Date.now() >= cred.expires) {
    cred = await refreshAndStore(state, account)
  }
  return JSON.stringify({ token: cred.accessToken, projectId: cred.projectId })
}

export const resolveKey = async (state: RouterState, account: Account): Promise<string> => {
  switch (account.type) {
    case 'api-key':
      return account.key
    case 'claude-cli': {
      const parsed = JSON.parse(await Bun.file(account.tokenPath).text()) as { oauthToken: string }
      return parsed.oauthToken
    }
    case 'antigravity-oauth':
      return resolveOAuthKey(state, account)
  }
}
