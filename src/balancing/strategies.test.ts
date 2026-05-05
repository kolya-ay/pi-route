// src/balancing/strategies.test.ts

import { describe, expect, it } from 'vitest'
import type { Account, AccountState } from '../types.js'
import {
  createFillFirstStrategy,
  createRoundRobinStrategy,
  createStickyStrategy,
} from './strategies.js'

const baseAccount: Account = { type: 'api-key', name: 'test', key: 'k' }

const makeState = (name: string, overrides: Partial<AccountState> = {}): AccountState => ({
  account: { ...baseAccount, name },
  rateLimits: new Map(),
  lastUsed: 0,
  isInvalid: false,
  requestCount: 0,
  ...overrides,
})

describe('createRoundRobinStrategy', () => {
  it('cycles through accounts sequentially', () => {
    const a = makeState('a')
    const b = makeState('b')
    const c = makeState('c')
    const strategy = createRoundRobinStrategy()
    expect(strategy.pick([a, b, c])?.account.name).toBe('a')
    expect(strategy.pick([a, b, c])?.account.name).toBe('b')
    expect(strategy.pick([a, b, c])?.account.name).toBe('c')
    expect(strategy.pick([a, b, c])?.account.name).toBe('a')
  })

  it('returns null for empty list', () => {
    const strategy = createRoundRobinStrategy()
    expect(strategy.pick([])).toBeNull()
  })
})

describe('createStickyStrategy', () => {
  it('prefers the most recently used account', () => {
    const a = makeState('a', { lastUsed: 100 })
    const b = makeState('b', { lastUsed: 200 })
    const c = makeState('c', { lastUsed: 50 })
    const strategy = createStickyStrategy()
    expect(strategy.pick([a, b, c])?.account.name).toBe('b')
  })

  it('falls back to round-robin when no account has been used', () => {
    const a = makeState('a')
    const b = makeState('b')
    const strategy = createStickyStrategy()
    expect(strategy.pick([a, b])?.account.name).toBe('a')
    expect(strategy.pick([a, b])?.account.name).toBe('b')
  })

  it('returns null for empty list', () => {
    const strategy = createStickyStrategy()
    expect(strategy.pick([])).toBeNull()
  })
})

describe('createFillFirstStrategy', () => {
  it('always picks the first account', () => {
    const a = makeState('a')
    const b = makeState('b')
    const strategy = createFillFirstStrategy()
    expect(strategy.pick([a, b])?.account.name).toBe('a')
    expect(strategy.pick([a, b])?.account.name).toBe('a')
  })

  it('returns null for empty list', () => {
    const strategy = createFillFirstStrategy()
    expect(strategy.pick([])).toBeNull()
  })
})
