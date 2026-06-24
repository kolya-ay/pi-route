import { type AccountRuntimeState, writeRuntimeState } from '../config/state'
import type { RouterState } from '../state'
import { AdminError } from './errors'

export type AccountStatus = {
  name: string
  provider: string
  type: string
  disabled: boolean
  isInvalid: boolean
}

const ensureRuntimeEntry = (state: RouterState, name: string): AccountRuntimeState => {
  const existing = state.runtime.accounts[name]
  if (existing) return existing
  const fresh: AccountRuntimeState = { isInvalid: false }
  state.runtime.accounts[name] = fresh
  return fresh
}

const requireProvider = (state: RouterState, name: string): void => {
  if (!state.options.providers[name]) {
    throw new AdminError('account_not_found', `unknown account "${name}"`, { name })
  }
}

export const listAccounts = (state: RouterState): AccountStatus[] => {
  const out: AccountStatus[] = []
  for (const [providerName, p] of Object.entries(state.options.providers)) {
    const r = state.runtime.accounts[providerName] ?? { isInvalid: false }
    const disabled = p.account.disabled ?? false
    out.push({
      name: providerName,
      provider: providerName,
      type: p.type,
      disabled,
      isInvalid: r.isInvalid
    })
  }
  return out
}

export const getAccount = (state: RouterState, name: string): AccountStatus | null => {
  return listAccounts(state).find((a) => a.name === name) ?? null
}

export const setAccountInvalid = async (
  state: RouterState,
  name: string,
  isInvalid: boolean
): Promise<void> => {
  requireProvider(state, name)
  const r = ensureRuntimeEntry(state, name)
  r.isInvalid = isInvalid
  await writeRuntimeState(state.authDir, state.runtime)
}
