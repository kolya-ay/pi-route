import { describe, expect, test } from 'bun:test'
import type { LimitsSnapshot } from '../limits'
import { formatLimits } from './limits'

describe('formatLimits', () => {
  const snapshot: LimitsSnapshot = {
    providers: [
      {
        name: 'cc',
        type: 'anthropic',
        display_name: 'Claude',
        status: 'ok',
        plan: 'Max',
        session: null,
        weekly: null,
        credits: { used: 4.2, cap: 50, currency: 'usd' },
        error_message: null,
        last_updated: null
      },
      {
        name: 'ag',
        type: 'openai-codex',
        display_name: 'Antigravity',
        status: 'error',
        plan: null,
        session: null,
        weekly: null,
        credits: null,
        error_message: 'token expired',
        last_updated: null
      }
    ]
  }

  test('table header, rows, credits, and a dim error continuation line', () => {
    const out = formatLimits(snapshot)
    const lines = out.split('\n')
    expect(lines[0]).toContain('PROVIDER')
    expect(lines[0]).toContain('CREDITS')
    expect(out).toContain('cc')
    expect(out).toContain('Max')
    expect(out).toContain('$4.20 / $50.00 usd')
    expect(out).toContain('ag: token expired') // error continuation
  })

  test('empty providers message', () => {
    expect(formatLimits({ providers: [] })).toBe('(no providers)')
  })
})
