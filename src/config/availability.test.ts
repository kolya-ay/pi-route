import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RouterOptions } from '../types'
import { availableProviders, isAvailable } from './availability'

const options = (): RouterOptions => ({
  providers: {
    key: { type: 'cerebras', account: { credential: 'key', key: 'k' } },
    oauth: { type: 'anthropic', account: { credential: 'oauth', name: 'anthropic-cc' } },
    off: { type: 'cerebras', account: { credential: 'key', key: 'k', disabled: true } }
  },
  pipeline: [],
  expose: []
})

describe('isAvailable', () => {
  test('key providers are always available', () => {
    const dir = mkdtempSync(join(tmpdir(), 'avail-'))
    expect(isAvailable(options(), dir, 'key')).toBe(true)
  })

  test('oauth without a credential file is unavailable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'avail-'))
    expect(isAvailable(options(), dir, 'oauth')).toBe(false)
  })

  test('oauth with a credential file is available', () => {
    const dir = mkdtempSync(join(tmpdir(), 'avail-'))
    writeFileSync(join(dir, 'anthropic-cc.json'), '{}')
    expect(isAvailable(options(), dir, 'oauth')).toBe(true)
  })

  test('disabled accounts are unavailable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'avail-'))
    expect(isAvailable(options(), dir, 'off')).toBe(false)
  })

  test('unknown providers are unavailable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'avail-'))
    expect(isAvailable(options(), dir, 'ghost')).toBe(false)
  })
})

test('availableProviders returns only the usable names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'avail-'))
  expect([...availableProviders(options(), dir)]).toEqual(['key'])
})
