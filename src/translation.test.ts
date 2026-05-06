import { describe, expect, it } from 'bun:test'

import { needsTranslation, providerWireFormat } from './translation'

describe('providerWireFormat', () => {
  it('returns anthropic for anthropic provider', () => {
    expect(providerWireFormat('anthropic')).toBe('anthropic')
  })

  it('returns openai for openai provider', () => {
    expect(providerWireFormat('openai')).toBe('openai')
  })

  it('returns null for antigravity (always translates)', () => {
    expect(providerWireFormat('antigravity')).toBeNull()
  })
})

describe('needsTranslation', () => {
  it('returns false when anthropic request hits anthropic provider', () => {
    expect(needsTranslation('anthropic', 'anthropic')).toBe(false)
  })

  it('returns false when openai request hits openai provider', () => {
    expect(needsTranslation('openai', 'openai')).toBe(false)
  })

  it('returns true when anthropic request hits openai provider', () => {
    expect(needsTranslation('anthropic', 'openai')).toBe(true)
  })

  it('returns true when openai request hits anthropic provider', () => {
    expect(needsTranslation('openai', 'anthropic')).toBe(true)
  })

  it('returns true for any request hitting antigravity', () => {
    expect(needsTranslation('anthropic', 'antigravity')).toBe(true)
    expect(needsTranslation('openai', 'antigravity')).toBe(true)
  })
})
