// src/cli/limits.ts

import type { LimitCredits, LimitsSnapshot, LimitWindow } from '../limits'
import { type Colorize, dim, EM_DASH, green, red, renderTable, untilShort } from './format'

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
