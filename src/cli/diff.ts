// src/cli/diff.ts

type Op = { tag: ' ' | '+' | '-'; line: string }

// Trailing newline is structural, not a line — drop it so files that end in "\n"
// don't diff a spurious empty last line. Empty string => no lines.
const toLines = (s: string): string[] => (s === '' ? [] : s.replace(/\n$/, '').split('\n'))

// LCS line diff. `lcs` is memoized recursion rather than a mutable DP table;
// the backtrack then walks i/j forward, emitting ops. O(n*m) — fine for
// config-file-sized inputs.
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
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    const ai = a[i]
    const bj = b[j]
    if (ai !== undefined && bj !== undefined && ai === bj) {
      ops.push({ tag: ' ', line: ai })
      i++
      j++
    } else if (ai !== undefined && (bj === undefined || lcs(i + 1, j) >= lcs(i, j + 1))) {
      ops.push({ tag: '-', line: ai })
      i++
    } else if (bj !== undefined) {
      ops.push({ tag: '+', line: bj })
      j++
    }
  }
  return ops
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
  const lines: string[] = []
  ops.forEach((o, i) => {
    if (o.tag !== ' ' || near(i)) lines.push(`  ${o.tag} ${o.line}`)
    else if (lines[lines.length - 1] !== '  ⋯') lines.push('  ⋯')
  })
  return lines.join('\n')
}
