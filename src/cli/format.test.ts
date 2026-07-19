import { describe, expect, test } from 'bun:test'
import {
  colorizeDiff,
  costPair,
  EM_DASH,
  humanCost,
  humanCount,
  renderTable,
  untilShort
} from './format'

describe('humanCount', () => {
  test('humanizes thousands and millions, dash for missing', () => {
    expect(humanCount(131072)).toBe('131k')
    expect(humanCount(1_500_000)).toBe('1.5M')
    expect(humanCount(2_000_000)).toBe('2M')
    expect(humanCount(512)).toBe('512')
    expect(humanCount(undefined)).toBe(EM_DASH)
    expect(humanCount(999_999)).toBe('1.0M') // boundary: no "1000k"
  })
})

describe('cost formatting', () => {
  test('costPair trims leading zero, dash for missing', () => {
    expect(costPair(0.35, 0.75)).toBe('.35/.75')
    expect(costPair(1.25, undefined)).toBe(`1.25/${EM_DASH}`)
    expect(costPair(undefined, undefined)).toBe(`${EM_DASH}/${EM_DASH}`)
  })
  test('humanCost is the long form', () => {
    expect(humanCost(0.35, 0.75)).toBe('$0.35 in · $0.75 out')
    expect(humanCost(undefined, 0.75)).toBe(`${EM_DASH} in · $0.75 out`)
  })
})

describe('untilShort', () => {
  const now = Date.parse('2026-07-19T00:00:00Z')
  test('compact relative future, dash/now edge cases', () => {
    expect(untilShort('2026-07-19T03:00:00Z', now)).toBe('3h')
    expect(untilShort('2026-07-23T00:00:00Z', now)).toBe('4d')
    expect(untilShort('2026-07-19T00:30:00Z', now)).toBe('30m')
    expect(untilShort('2026-07-18T00:00:00Z', now)).toBe('now')
    expect(untilShort(null, now)).toBe(EM_DASH)
  })
})

describe('renderTable', () => {
  test('aligns columns on plain widths, bold header, rule row', () => {
    const out = renderTable(
      ['MODEL', 'CTX'],
      [
        ['a', '131k'],
        ['bbbb', '—']
      ]
    )
    const lines = out.split('\n')
    // header, rule, two body rows
    expect(lines).toHaveLength(4)
    // column 0 width = max('MODEL'=5, 'a', 'bbbb') = 5; two-space gap
    expect(lines[2]).toBe('a      131k')
    expect(lines[3]).toBe('bbbb   —')
    expect(lines[1]).toBe('-----  ----')
  })
  test('colorize callback receives padded plain cell and row/col indices', () => {
    const seen: string[] = []
    renderTable(['A'], [['x'], ['y']], (row, col, cell) => {
      seen.push(`${row}:${col}:${cell}`)
      return cell
    })
    expect(seen).toEqual(['0:0:x', '1:0:y'])
  })
})

describe('colorizeDiff', () => {
  test('is identity on content off-TTY (no escapes), preserves structure', () => {
    const body = '  + added\n  - removed\n    context'
    // Off-TTY styleText is a noop, so lines are unchanged.
    expect(colorizeDiff(body)).toBe(body)
  })
})
