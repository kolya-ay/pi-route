// src/balancing/strategies.ts

import type { AccountState, BalancingStrategy } from '../types'

export const createRoundRobinStrategy = (): BalancingStrategy => {
  let index = 0
  return {
    name: 'round-robin',
    pick(accounts: AccountState[]): AccountState | null {
      if (accounts.length === 0) return null
      const picked = accounts[index % accounts.length] ?? null
      index = (index + 1) % accounts.length
      return picked
    }
  }
}

export const createStickyStrategy = (): BalancingStrategy => {
  let rrIndex = 0
  return {
    name: 'sticky',
    pick(accounts: AccountState[]): AccountState | null {
      if (accounts.length === 0) return null
      const hasUsed = accounts.some((a) => a.lastUsed > 0)
      if (hasUsed) {
        return accounts.reduce((best, cur) => (cur.lastUsed > best.lastUsed ? cur : best))
      }
      // fall back to round-robin
      const picked = accounts[rrIndex % accounts.length] ?? null
      rrIndex = (rrIndex + 1) % accounts.length
      return picked
    }
  }
}

export const createFillFirstStrategy = (): BalancingStrategy => ({
  name: 'fill-first',
  pick(accounts: AccountState[]): AccountState | null {
    return accounts[0] ?? null
  }
})
