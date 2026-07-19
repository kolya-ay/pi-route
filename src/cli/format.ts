import { styleText } from 'node:util'

type Style = 'dim' | 'bold' | 'green' | 'red' | 'cyan'

// Layout gate: is stdout an interactive terminal? Governs table-vs-plain choices
// (e.g. `models list`). Independent of NO_COLOR — a NO_COLOR terminal still gets
// the human layout, just without color.
export const isTTY = (): boolean => process.stdout.isTTY === true

// Color gate. NO_COLOR wins; FORCE_COLOR forces on even off-TTY; else require a TTY.
const useColor = (): boolean => {
  if (process.env.NO_COLOR) return false
  if (process.env.FORCE_COLOR) return true
  return isTTY()
}

// Bun's styleText (as of 1.3.13) always emits escapes regardless of TTY/NO_COLOR,
// so we gate it ourselves rather than relying on native auto-detection.
const paint =
  (style: Style) =>
  (s: string): string =>
    useColor() ? styleText(style, s) : s

export const dim = paint('dim')
export const bold = paint('bold')
export const green = paint('green')
export const red = paint('red')
export const cyan = paint('cyan')

export const EM_DASH = '—'

// 131072 -> "131k", 1_500_000 -> "1.5M", undefined -> "—".
export const humanCount = (n: number | undefined): string => {
  if (n === undefined || Number.isNaN(n)) return EM_DASH
  if (n < 1_000) return String(n)
  const k = Math.round(n / 1_000)
  if (k < 1_000) return `${k}k`
  const millions = n / 1_000_000
  return `${millions % 1 === 0 ? millions.toFixed(0) : millions.toFixed(1)}M`
}

// USD per 1M tokens. "0.35" -> ".35" for compactness; missing -> "—".
const trimCost = (n: number): string => {
  const s = n.toFixed(2)
  return s.startsWith('0.') ? s.slice(1) : s
}
export const costPair = (input?: number, output?: number): string =>
  `${input === undefined ? EM_DASH : trimCost(input)}/${output === undefined ? EM_DASH : trimCost(output)}`

export const humanCost = (input?: number, output?: number): string => {
  const one = (n?: number): string => (n === undefined ? EM_DASH : `$${n.toFixed(2)}`)
  return `${one(input)} in · ${one(output)} out`
}

// Compact relative time from now to `iso` (e.g. "3h", "4d"). Past/near -> "now".
export const untilShort = (iso: string | null, nowMs: number = Date.now()): string => {
  if (!iso) return EM_DASH
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return EM_DASH
  const diffMs = t - nowMs
  if (diffMs <= 0) return 'now'
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

export type Colorize = (row: number, col: number, plainCell: string) => string

// Aligned table. Widths are measured on PLAIN strings and each cell is padded
// BEFORE color is applied (via `colorize`), so invisible ANSI escapes never
// inflate column widths. The last column is left unpadded (nothing trails it,
// so no need to fill it with trailing spaces). Header is bold; a '-'-rule row
// spans each column's full measured width.
export const renderTable = (headers: string[], rows: string[][], colorize?: Colorize): string => {
  const lastCol = headers.length - 1
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const cell = (v: string, i: number): string => (i === lastCol ? v : v.padEnd(widths[i] ?? 0))
  const headerCells = headers.map((h, i) => cell(h, i))
  const headerLine = headerCells.map(bold).join('  ')
  const ruleLine = widths.map((w) => '-'.repeat(w)).join('  ')
  const body = rows.map((r, ri) =>
    headers
      .map((_, ci) => {
        const padded = cell(r[ci] ?? '', ci)
        return colorize ? colorize(ri, ci, padded) : padded
      })
      .join('  ')
  )
  return [headerLine, ruleLine, ...body].join('\n')
}

// Git-style diff coloring: '+' lines green, '-' lines red, collapsed/no-change
// markers dim. Matches the "  {tag} line" shape emitted by unifiedDiff().
export const colorizeDiff = (text: string): string =>
  text
    .split('\n')
    .map((line) => {
      if (/^ {2}\+ /.test(line)) return green(line)
      if (/^ {2}- /.test(line)) return red(line)
      if (line.startsWith('  ⋯') || line === '  (no changes)') return dim(line)
      return line
    })
    .join('\n')
