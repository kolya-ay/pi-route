import { describe, expect, test } from 'bun:test'
import { type PerTokenUsd, perTokenUsd } from './money'

// PerTokenUsd erases to number at runtime; cast the received value so bun's
// matcher types accept plain numeric expectations (toBe infers its argument
// from the branded received type).
describe('money brands', () => {
  test('perTokenUsd scales a per-million rate to per-token, exact for round values', () => {
    expect(perTokenUsd(0.1) as number).toBe(1e-7)
    expect(perTokenUsd(0.5) as number).toBe(5e-7)
    expect(perTokenUsd(2) as number).toBe(2e-6)
  })

  test('a non-round rate converts within floating-point tolerance', () => {
    expect(perTokenUsd(0.104) as number).toBeCloseTo(1.04e-7, 20)
  })

  test('a zero rate stays zero', () => {
    expect(perTokenUsd(0) as number).toBe(0)
  })

  test('a raw number is not assignable to PerTokenUsd (the compile barrier)', () => {
    // @ts-expect-error PerTokenUsd is not a plain number — this is the guard that
    // makes a dropped perTokenUsd() conversion fail to compile at the metrics boundary.
    const rate: PerTokenUsd = 1e-7
    expect(rate as number).toBe(1e-7)
  })
})
