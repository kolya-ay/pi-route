// src/balancing/account-pool.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account } from '../types.js'
import { createAccountPool } from './account-pool.js'
import { createFillFirstStrategy, createRoundRobinStrategy } from './strategies.js'

const makeAccount = (name: string): Account => ({ type: 'api-key', name, key: `key-${name}` })

describe('createAccountPool', () => {
  it('selects an available account', () => {
    const pool = createAccountPool([makeAccount('a')], createFillFirstStrategy(), false)
    const result = pool.select('gpt-4')
    expect(result?.account.name).toBe('a')
    expect(result?.requestCount).toBe(1)
    expect(result?.lastUsed).toBeGreaterThan(0)
  })

  it('returns null when no accounts', () => {
    const pool = createAccountPool([], createFillFirstStrategy(), false)
    expect(pool.select('gpt-4')).toBeNull()
  })

  it('excludes rate-limited accounts for the model', () => {
    const pool = createAccountPool(
      [makeAccount('a'), makeAccount('b')],
      createFillFirstStrategy(),
      true,
    )
    const stateA = pool.states[0]!
    pool.markRateLimited(stateA, 'gpt-4', 60_000)
    const result = pool.select('gpt-4')
    expect(result?.account.name).toBe('b')
  })

  it('rate-limited for one model does not affect another (rateLimitPerModel true)', () => {
    const pool = createAccountPool([makeAccount('a')], createFillFirstStrategy(), true)
    const stateA = pool.states[0]!
    pool.markRateLimited(stateA, 'gpt-4', 60_000)
    const result = pool.select('claude-3')
    expect(result?.account.name).toBe('a')
  })

  it('rate limit blocks all models when rateLimitPerModel false', () => {
    const pool = createAccountPool(
      [makeAccount('a'), makeAccount('b')],
      createFillFirstStrategy(),
      false,
    )
    const stateA = pool.states[0]!
    pool.markRateLimited(stateA, 'gpt-4', 60_000)
    const result = pool.select('claude-3')
    expect(result?.account.name).toBe('b')
  })

  it('excludes invalid accounts', () => {
    const pool = createAccountPool(
      [makeAccount('a'), makeAccount('b')],
      createFillFirstStrategy(),
      false,
    )
    pool.markError(pool.states[0]!, { status: 401, message: 'Unauthorized' })
    expect(pool.select('gpt-4')?.account.name).toBe('b')
  })

  it('does not mark invalid on non-auth errors', () => {
    const pool = createAccountPool([makeAccount('a')], createFillFirstStrategy(), false)
    const stateA = pool.states[0]!
    pool.markError(stateA, { status: 500, message: 'Server Error' })
    expect(stateA.isInvalid).toBe(false)
    expect(stateA.lastError?.message).toBe('Server Error')
  })

  describe('expired rate limits', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('clears expired rate limits and makes account available again', () => {
      const pool = createAccountPool([makeAccount('a')], createFillFirstStrategy(), true)
      const stateA = pool.states[0]!
      pool.markRateLimited(stateA, 'gpt-4', 1_000)
      expect(pool.select('gpt-4')).toBeNull()
      vi.advanceTimersByTime(2_000)
      expect(pool.select('gpt-4')?.account.name).toBe('a')
    })
  })

  it('returns health summary', () => {
    const pool = createAccountPool(
      [makeAccount('a'), makeAccount('b'), makeAccount('c')],
      createRoundRobinStrategy(),
      false,
    )
    pool.markRateLimited(pool.states[0]!, 'gpt-4', 60_000)
    pool.markError(pool.states[1]!, { status: 403, message: 'Forbidden' })
    const h = pool.health()
    expect(h.total).toBe(3)
    expect(h.rateLimited).toBe(1)
    expect(h.invalid).toBe(1)
    expect(h.available).toBe(1)
  })
})
