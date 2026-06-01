// src/balancing/account-pool.ts

import type { Account, AccountState, BalancingStrategy } from '../types'

const makeState = (account: Account): AccountState => ({
  account,
  rateLimits: new Map(),
  lastUsed: 0,
  isInvalid: false,
  requestCount: 0
})

const hasAnyActiveRateLimit = (state: AccountState): boolean => {
  const now = Date.now()
  return Array.from(state.rateLimits.values()).some((expiry) => expiry > now)
}

const isRateLimited = (state: AccountState, model: string, perModel: boolean): boolean => {
  if (perModel) {
    const expiry = state.rateLimits.get(model)
    return expiry !== undefined && expiry > Date.now()
  }
  return hasAnyActiveRateLimit(state)
}

const isAvailable = (state: AccountState, model: string, perModel: boolean): boolean =>
  !state.account.disabled && !state.isInvalid && !isRateLimited(state, model, perModel)

export const createAccountPool = (
  getAccounts: () => Account[],
  strategy: BalancingStrategy,
  rateLimitPerModel: boolean
) => {
  // Map<accountName, AccountState> — created lazily as accounts appear
  const stateByName = new Map<string, AccountState>()

  const currentStates = (): AccountState[] =>
    getAccounts().map((account) => {
      const existing = stateByName.get(account.name)
      if (existing) {
        // Refresh the account reference (may have new `disabled` value)
        existing.account = account
        return existing
      }
      const fresh = makeState(account)
      stateByName.set(account.name, fresh)
      return fresh
    })

  return {
    get states() {
      return currentStates()
    },

    select(model: string): AccountState | null {
      const available = currentStates().filter((s) => isAvailable(s, model, rateLimitPerModel))
      const picked = strategy.pick(available)
      if (picked) {
        picked.lastUsed = Date.now()
        picked.requestCount += 1
      }
      return picked
    },

    markRateLimited(state: AccountState, model: string, retryAfterMs: number): void {
      state.rateLimits.set(model, Date.now() + retryAfterMs)
    },

    markError(state: AccountState, error: { status?: number; message: string }): void {
      Object.assign(state, {
        lastError: { message: error.message, at: Date.now() },
        ...(error.status === 401 || error.status === 403 ? { isInvalid: true } : {})
      })
    },

    health(): { total: number; available: number; rateLimited: number; invalid: number } {
      const states = currentStates()
      const total = states.length
      const invalid = states.filter((s) => s.isInvalid).length
      const rateLimited = states.filter((s) => !s.isInvalid && hasAnyActiveRateLimit(s)).length
      const available = states.filter(
        (s) => !s.account.disabled && !s.isInvalid && !hasAnyActiveRateLimit(s)
      ).length
      return { total, available, rateLimited, invalid }
    }
  }
}
