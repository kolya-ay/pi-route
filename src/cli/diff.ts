// src/cli/diff.ts

type Op = { tag: ' ' | '+' | '-'; line: string }

// Trailing newline is structural, not a line — drop it so files that end in "\n"
// don't diff a spurious empty last line. Empty string => no lines.
const toLines = (s: string): string[] => (s === '' ? [] : s.replace(/\n$/, '').split('\n'))

// LCS line diff. `lcs` is memoized recursion rather than a mutable DP table; the
// only mutation is the memo cache. O(n*m) — fine for config-file-sized inputs.
const diffOps = (a: string[], b: string[]): Op[] => {
  const memo = new Map<string, number>()
  const lcs = (i: number, j: number): number => {
    if (i >= a.length || j >= b.length) return 0
    const key = `${i},${j}`
    const cached = memo.get(key)
    if (cached !== undefined) return cached
    const val = a[i] === b[j] ? lcs(i + 1, j + 1) + 1 : Math.max(lcs(i + 1, j), lcs(i, j + 1))
    memo.set(key, val)
    return val
  }
  const walk = (i: number, j: number, acc: Op[]): Op[] => {
    if (i >= a.length && j >= b.length) return acc
    if (i < a.length && j < b.length && a[i] === b[j])
      return walk(i + 1, j + 1, [...acc, { tag: ' ', line: a[i]! }])
    if (j >= b.length || (i < a.length && lcs(i + 1, j) >= lcs(i, j + 1)))
      return walk(i + 1, j, [...acc, { tag: '-', line: a[i]! }])
    return walk(i, j + 1, [...acc, { tag: '+', line: b[j]! }])
  }
  return walk(0, 0, [])
}

// Unchanged lines kept around each change; longer gaps collapse to "  ⋯".
const CONTEXT = 3

// Unified diff body: every changed line, plus CONTEXT unchanged lines around
// each change; longer unchanged gaps collapse to a single "  ⋯". Returns
// "  (no changes)" when before === after (idempotent re-run signal).
export const unifiedDiff = (before: string, after: string): string => {
  const ops = diffOps(toLines(before), toLines(after))
  if (ops.every((o) => o.tag === ' ')) return '  (no changes)'
  const near = (i: number): boolean =>
    ops.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((o) => o.tag !== ' ')
  return ops
    .reduce<string[]>((acc, o, i) => {
      if (o.tag !== ' ' || near(i)) return [...acc, `  ${o.tag} ${o.line}`]
      return acc[acc.length - 1] === '  ⋯' ? acc : [...acc, '  ⋯']
    }, [])
    .join('\n')
}
