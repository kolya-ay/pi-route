import { expect, test } from 'bun:test'

import { unifiedDiff } from './diff'

test('unifiedDiff renders every line of an empty-before as an addition', () => {
  expect(unifiedDiff('', 'a\nb\n')).toBe('  + a\n  + b')
})

test('unifiedDiff shows a changed line with surrounding context', () => {
  const before = 'one\ntwo\nthree\nfour\nfive\n'
  const after = 'one\ntwo\nTHREE\nfour\nfive\n'
  const out = unifiedDiff(before, after)
  expect(out).toContain('  - three')
  expect(out).toContain('  + THREE')
  expect(out).toContain('    two') // unchanged context kept
})

test('unifiedDiff collapses far-away unchanged lines to an ellipsis', () => {
  const before = `${Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n')}\n`
  const after = before.replace('line0', 'CHANGED0')
  const out = unifiedDiff(before, after)
  expect(out).toContain('  - line0')
  expect(out).toContain('  + CHANGED0')
  expect(out).toContain('  ⋯') // distant unchanged lines collapsed
  expect(out).not.toContain('line19') // far tail omitted
})

test('unifiedDiff returns (no changes) when before equals after', () => {
  expect(unifiedDiff('a\nb\n', 'a\nb\n')).toBe('  (no changes)')
})
