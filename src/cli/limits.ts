// src/cli/limits.ts

import type {
  LimitAccount,
  LimitCredits,
  LimitSpend,
  LimitsSnapshot,
  LimitWindow,
  ProviderLimitSnapshot
} from '../limits'
import { usageError } from './errors'
import { bold, type Colorize, dim, EM_DASH, green, red, renderTable, untilShort } from './format'

const win = (w: LimitWindow | null): string =>
  w ? `${Math.round(w.used_percent)}% (${untilShort(w.resets_at)})` : EM_DASH

const credits = (c: LimitCredits | null): string =>
  c ? `$${c.used.toFixed(2)} / $${c.cap.toFixed(2)} ${c.currency}` : EM_DASH

// Human table over a rate-limit snapshot. Status is colored; an errored provider
// gets a dim continuation line with its message. `--json` bypasses this entirely.
export const formatLimits = (snapshot: LimitsSnapshot): string => {
  const providers = snapshot.providers
  if (providers.length === 0) return '(no providers)'
  const rows = providers.map((p) => [
    p.name,
    p.plan ?? EM_DASH,
    p.status,
    win(p.session),
    win(p.weekly),
    credits(p.credits)
  ])
  const colorize: Colorize = (_ri, ci, cell) => {
    if (ci !== 2) return cell
    const s = cell.trim()
    return s === 'ok' ? green(cell) : s === 'error' ? red(cell) : dim(cell)
  }
  const table = renderTable(
    ['PROVIDER', 'PLAN', 'STATUS', 'SESSION', 'WEEKLY', 'CREDITS'],
    rows,
    colorize
  )
  const errs = providers
    .filter((p) => p.status === 'error' && p.error_message)
    .map((p) => dim(`  ${p.name}: ${p.error_message}`))
  return errs.length > 0 ? `${table}\n${errs.join('\n')}` : table
}

// Shared by the detail view and `--json <name>`, so both fail the same way on a typo'd name.
export const findProviderSnapshot = (
  snapshot: LimitsSnapshot,
  name: string
): ProviderLimitSnapshot => {
  const p = snapshot.providers.find((entry) => entry.name === name)
  if (p) return p
  const known = snapshot.providers.map((entry) => entry.name).join(', ')
  throw usageError(`no usage limits for provider "${name}"${known ? ` (known: ${known})` : ''}`)
}

// email and organization_type are independent; show whichever is present.
const accountLine = (a: LimitAccount | null): string | null => {
  const parts = [a?.email, a?.organization_type].filter((v) => v != null)
  return parts.length > 0 ? dim(`  ${parts.join(' · ')}`) : null
}

const spendLine = (s: LimitSpend): string => {
  const cap = s.cap === null ? EM_DASH : `$${s.cap.toFixed(2)}`
  const state = s.enabled
    ? 'enabled'
    : `disabled${s.disabled_reason ? `: ${s.disabled_reason}` : ''}`
  return `$${s.used.toFixed(2)} / ${cap} ${s.currency} (${state})`
}

// One provider, everything known about it. `provider limits` keeps the table;
// `provider limits <name>` trades the six lean columns for this full picture.
export const formatLimitsDetail = (snapshot: LimitsSnapshot, name: string): string => {
  const p = findProviderSnapshot(snapshot, name)
  const rows = p.windows.map((w) => [
    w.scope ? `${w.kind} (${w.scope})` : w.kind,
    `${Math.round(w.used_percent)}%`,
    untilShort(w.resets_at),
    w.active ? 'active' : 'inactive'
  ])
  // Cells stay plain here so renderTable measures true widths; color is applied
  // after padding via `colorize`, same as formatLimits' STATUS column.
  const stateColorize: Colorize = (_ri, ci, cell) =>
    ci === 3 && cell.trim() === 'inactive' ? dim(cell) : cell
  const account = accountLine(p.account)
  const lines = [
    `${bold(p.display_name)}  ${p.name}  ${p.plan ?? EM_DASH}  ${p.status}`,
    ...(account ? [account] : []),
    rows.length > 0
      ? renderTable(['WINDOW', 'USED', 'RESETS', 'STATE'], rows, stateColorize)
      : dim('  (no windows reported)'),
    ...(p.spend ? [`  spend  ${spendLine(p.spend)}`] : []),
    ...(p.credits ? [`  credits  ${credits(p.credits)}`] : []),
    ...(p.error_message ? [dim(`  ${p.error_message}`)] : [])
  ]
  return lines.join('\n')
}
