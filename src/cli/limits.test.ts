import { describe, expect, test } from 'bun:test'
import type { LimitsSnapshot } from '../limits'
import { formatLimits, formatLimitsDetail } from './limits'

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
        windows: [],
        spend: null,
        account: null,
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
        windows: [],
        spend: null,
        account: null,
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

describe('formatLimitsDetail', () => {
  test('the detail view prints every window, the spend state, and the account', () => {
    const snapshot = {
      providers: [
        {
          name: 'cc',
          type: 'anthropic' as const,
          display_name: 'Claude Code',
          status: 'ok' as const,
          plan: 'Max 5x',
          session: { used_percent: 12, resets_at: null },
          weekly: { used_percent: 0, resets_at: null },
          credits: null,
          windows: [
            {
              kind: 'session',
              used_percent: 12,
              resets_at: null,
              window_seconds: null,
              active: true,
              scope: null
            },
            {
              kind: 'weekly_scoped',
              used_percent: 5,
              resets_at: null,
              window_seconds: null,
              active: false,
              scope: 'Fable'
            }
          ],
          spend: {
            used: 102.22,
            cap: 100,
            currency: 'USD',
            enabled: false,
            disabled_reason: 'org_level_disabled_until'
          },
          account: { email: 'someone@example.test', organization_type: 'claude_max' },
          error_message: null,
          last_updated: null
        }
      ]
    }

    const out = formatLimitsDetail(snapshot, 'cc')
    expect(out).toContain('Max 5x')
    expect(out).toContain('weekly_scoped')
    expect(out).toContain('Fable')
    expect(out).toContain('102.22')
    expect(out).toContain('org_level_disabled_until')
    expect(out).toContain('someone@example.test')
  })

  test('an unknown provider name is reported, not silently empty', () => {
    expect(() => formatLimitsDetail({ providers: [] }, 'nope')).toThrow(/nope/)
  })

  test('organization_type still prints when email is null', () => {
    const snapshot: LimitsSnapshot = {
      providers: [
        {
          name: 'cc',
          type: 'anthropic',
          display_name: 'Claude Code',
          status: 'ok',
          plan: 'Max 5x',
          session: null,
          weekly: null,
          credits: null,
          windows: [],
          spend: null,
          account: { email: null, organization_type: 'claude_max' },
          error_message: null,
          last_updated: null
        }
      ]
    }

    const out = formatLimitsDetail(snapshot, 'cc')
    expect(out).toContain('claude_max')
  })

  test('a provider with no windows, spend, or account renders without crashing or an empty table', () => {
    const snapshot: LimitsSnapshot = {
      providers: [
        {
          name: 'codex',
          type: 'openai-codex',
          display_name: 'Codex',
          status: 'unauthenticated',
          plan: null,
          session: null,
          weekly: null,
          credits: null,
          windows: [],
          spend: null,
          account: null,
          error_message: 'OAuth login required for Codex usage.',
          last_updated: null
        }
      ]
    }

    const out = formatLimitsDetail(snapshot, 'codex')
    expect(out).toContain('Codex')
    expect(out).toContain('OAuth login required for Codex usage.')
    expect(out).not.toContain('WINDOW')
  })
})
