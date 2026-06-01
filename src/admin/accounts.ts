import type { OAuthLoginCallbacks } from '@mariozechner/pi-ai/oauth'
import { LoginTimeoutError, loginAntigravity } from '../auth/antigravity-oauth'
import { writeCredentials } from '../auth/credentials'
import { cancelRefresh, scheduleRefresh } from '../auth/scheduler'
import { AccountSchema } from '../config/schema'
import type { RouterState } from '../state'
import type { Account, CredentialFile } from '../types'
import { AdminError } from './errors'

export const listAccounts = (
  state: RouterState
): Array<{ provider: string; account: Account; expires?: number }> => {
  const out: Array<{ provider: string; account: Account; expires?: number }> = []
  for (const [providerName, provider] of Object.entries(state.options.providers)) {
    for (const account of provider.accounts) {
      const expires = state.credentials.get(account.name)?.expires
      out.push({ provider: providerName, account, ...(expires !== undefined ? { expires } : {}) })
    }
  }
  return out
}

// Callers (addAccount, removeAccount, disableAccount) always validate provider via
// findAccount or an explicit lookup before swap, so the non-null assertion is safe.
const swap = (state: RouterState, providerName: string, accounts: Account[]): void => {
  const provider = state.options.providers[providerName]!
  state.options = {
    ...state.options,
    providers: {
      ...state.options.providers,
      [providerName]: { ...provider, accounts }
    }
  }
}

const persistOrEmit = async (state: RouterState): Promise<void> => {
  try {
    await state.persist?.(state.options)
  } catch (err) {
    state.telemetry.emit({
      type: 'admin.persist-failed',
      error: err instanceof Error ? err.message : String(err)
    })
    throw err
  }
}

const findAccount = (state: RouterState, providerName: string, accountName: string): Account => {
  const provider = state.options.providers[providerName]
  if (!provider)
    throw new AdminError('provider_not_found', `Provider not found: ${providerName}`, {
      provider: providerName
    })
  const found = provider.accounts.find((a) => a.name === accountName)
  if (!found)
    throw new AdminError('account_not_found', `Account not found: ${providerName}/${accountName}`, {
      provider: providerName,
      name: accountName
    })
  return found
}

export const addAccount = async (
  state: RouterState,
  providerName: string,
  account: Account
): Promise<void> => {
  const validated = AccountSchema.parse(account)
  const provider = state.options.providers[providerName]
  if (!provider)
    throw new AdminError('provider_not_found', `Provider not found: ${providerName}`, {
      provider: providerName
    })
  if (provider.accounts.some((a) => a.name === validated.name)) {
    throw new AdminError(
      'account_conflict',
      `Account already exists: ${providerName}/${validated.name}`,
      { provider: providerName, name: validated.name }
    )
  }
  swap(state, providerName, [...provider.accounts, validated])
  scheduleRefresh(state, providerName, validated)
  await persistOrEmit(state)
}

export const removeAccount = async (
  state: RouterState,
  providerName: string,
  accountName: string
): Promise<void> => {
  findAccount(state, providerName, accountName)
  cancelRefresh(state, accountName)
  state.credentials.delete(accountName)
  const provider = state.options.providers[providerName]!
  swap(
    state,
    providerName,
    provider.accounts.filter((a) => a.name !== accountName)
  )
  await persistOrEmit(state)
}

export const disableAccount = async (
  state: RouterState,
  providerName: string,
  accountName: string,
  disabled: boolean
): Promise<void> => {
  const account = findAccount(state, providerName, accountName)
  const updated: Account = { ...account, disabled }
  if (disabled) {
    cancelRefresh(state, accountName)
  } else {
    // cancelRefresh first resets the failure counter so a previously
    // given-up account can be re-armed from a clean slate.
    cancelRefresh(state, accountName)
    scheduleRefresh(state, providerName, updated)
  }
  const provider = state.options.providers[providerName]!
  swap(
    state,
    providerName,
    provider.accounts.map((a) => (a.name === accountName ? updated : a))
  )
  await persistOrEmit(state)
}

export const loginAccount = async (
  state: RouterState,
  providerName: string,
  accountName: string,
  callbacks: OAuthLoginCallbacks,
  opts?: { signal?: AbortSignal }
): Promise<void> => {
  const account = findAccount(state, providerName, accountName)

  if (account.type !== 'antigravity-oauth') {
    throw new Error(`Login not supported for account type '${account.type}'`)
  }

  const credentials = await loginAntigravity(callbacks, undefined, opts?.signal).catch(
    (err: unknown) => {
      if (err instanceof LoginTimeoutError) {
        throw new AdminError('login_timeout', err.message, { account: accountName })
      }
      throw err
    }
  )

  const cred: CredentialFile = {
    provider: 'google-antigravity',
    refreshToken: credentials.refresh,
    accessToken: credentials.access,
    expires: credentials.expires,
    ...(credentials.projectId !== undefined ? { projectId: credentials.projectId } : {})
  }
  await writeCredentials(state.options.authDir, accountName, cred)
  state.credentials.set(accountName, cred)
  // scheduleRefresh internally cancels any existing timer; explicit cancel here
  // also resets the failure counter so a previously given-up account starts fresh.
  cancelRefresh(state, accountName)
  scheduleRefresh(state, providerName, account)
}
