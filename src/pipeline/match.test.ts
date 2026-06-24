import { describe, expect, test } from 'bun:test'
import { compileGlob, exposeIncludes, matches, substitute } from './match'

describe('compileGlob', () => {
  test('star compiles to non-slash group', () => {
    const c = compileGlob('claude-pool/*')
    expect(c.regex.source).toBe('^claude\\-pool\\/([^/]*)$')
  })
  test('double-star compiles to dotall group', () => {
    expect(compileGlob('claude-pool/**').regex.source).toBe('^claude\\-pool\\/(.*)$')
  })
  test('question mark matches one char but does not capture', () => {
    const c = compileGlob('a?b')
    expect(c.regex.source).toBe('^a[^/]b$')
  })
  test('character class', () => {
    expect(compileGlob('v[12]').regex.source).toBe('^v[12]$')
  })
  test('literal special chars are escaped', () => {
    expect(compileGlob('llama-3.3-70b').regex.source).toBe('^llama\\-3\\.3\\-70b$')
  })
  test('exact match', () => {
    expect(compileGlob('opus').regex.source).toBe('^opus$')
  })
})

describe('matches', () => {
  test('star matches one segment', () => {
    expect(matches('claude-pool/*', 'claude-pool/foo')).toEqual(['foo'])
    expect(matches('claude-pool/*', 'claude-pool/a/b')).toBeNull()
  })
  test('double-star matches multiple segments', () => {
    expect(matches('claude-pool/**', 'claude-pool/a/b')).toEqual(['a/b'])
    expect(matches('claude-pool/**', 'claude-pool/')).toEqual([''])
  })
  test('exact returns empty captures on hit', () => {
    expect(matches('opus', 'opus')).toEqual([])
    expect(matches('opus', 'sonnet')).toBeNull()
  })
})

describe('substitute', () => {
  test('positional captures', () => {
    expect(substitute('claude-personal/$1', ['foo'])).toBe('claude-personal/foo')
  })
  test('$0 is the current model passed separately', () => {
    expect(substitute('thinking/$0', [], 'opus')).toBe('thinking/opus')
  })
  test('unbound capture is a hard error', () => {
    expect(() => substitute('a/$1', [], 'm')).toThrow(/unbound capture/)
  })
})

describe('exposeIncludes (gitignore late-wins)', () => {
  test('empty list includes everything', () => {
    expect(exposeIncludes([], 'anything')).toBe(true)
  })
  test('positive then negation', () => {
    expect(exposeIncludes(['**', '!chutes/**'], 'cerebras/x')).toBe(true)
    expect(exposeIncludes(['**', '!chutes/**'], 'chutes/x')).toBe(false)
  })
  test('negation then positive re-adds', () => {
    expect(exposeIncludes(['!**', 'opus'], 'opus')).toBe(true)
    expect(exposeIncludes(['!**', 'opus'], 'sonnet')).toBe(false)
  })
  test('allowlist mode (no implicit **)', () => {
    expect(exposeIncludes(['opus', 'sonnet'], 'opus')).toBe(true)
    expect(exposeIncludes(['opus', 'sonnet'], 'fast')).toBe(false)
  })
})
