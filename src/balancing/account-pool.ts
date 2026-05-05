// src/balancing/account-pool.ts

import type { Account, AccountState, BalancingStrategy } from '../types.js'

const makeState = (account: Account): AccountState => ({
  account,
  rateLimits: new Map(),
  lastUsed: 0,
  isInvalid: false,
  requestCount: 0,
})

const isRateLimited = (state: AccountState, model: string, perModel: boolean): boolean => {
  const now = Date.now()
  if (perModel) {
    const expiry = state.rateLimits.get(model)
    return expiry !== undefined && expiry > now
  }
  // any active rate limit blocks the account for all models
  return Array.from(state.rateLimits.values()).some((expiry) => expiry > now)
}

const isAvailable = (state: AccountState, model: string, perModel: boolean): boolean =>
  !state.isInvalid && !isRateLimited(state, model, perModel)

export const createAccountPool = (
  accounts: Account[],
  strategy: BalancingStrategy,
  rateLimitPerModel: boolean,
) => {
  const states = accounts.map(makeState)

  return {
    states,

    select(model: string): AccountState | null {
      const available = states.filter((s) => isAvailable(s, model, rateLimitPerModel))
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
      state.lastError = { message: error.message, at: Date.now() }
      if (error.status === 401 || error.status === 403) {
        state.isInvalid = true
      }
    },

    health(): { total: number; available: number; rateLimited: number; invalid: number } {
      const now = Date.now()
      const total = states.length
      const invalid = states.filter((s) => s.isInvalid).length
      const rateLimited = states.filter(
        (s) =>
          !s.isInvalid && Array.from(s.rateLimits.values()).some((expiry) => expiry > now),
      ).length
      const available = states.filter(
        (s) => !s.isInvalid && !Array.from(s.rateLimits.values()).some((expiry) => expiry > now),
      ).length
      return { total, available, rateLimited, invalid }
    },
  }
}
