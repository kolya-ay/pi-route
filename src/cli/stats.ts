// src/cli/stats.ts
//
// JSON-RPC client for otel-desktop-viewer (v0.2.5). Two non-obvious points:
//   - getTraceByID takes POSITIONAL params: [traceId], not { traceId }.
//   - There is no server-side filter API; we fetch all summaries, fetch each
//     trace, flatten spans, and aggregate client-side.

export type StatsBy = 'provider' | 'model' | 'day' | 'session'

export type StatsRow = {
  key: string
  requests: number
  cost_usd: number
  tokens_in?: number
  tokens_out?: number
}

export type StatsArgs = {
  by: StatsBy
  since: string
}

type Span = {
  name: string
  attributes: Record<string, unknown>
  startTime: string
}

type TraceSummary = { traceID: string }

type TraceDetail = { spans: { spanData: Span }[] }

const resolveViewerUrl = (): string => {
  const url = process.env.PI_ROUTE_VIEWER_URL
  if (url) return url
  return `http://localhost:${process.env.PI_ROUTE_VIEWER_PORT ?? '8000'}`
}

const sinceCutoffNanos = (since: string): bigint => {
  const m = since.match(/^(\d+)([dh])$/)
  if (!m) throw new Error(`Invalid --since value: "${since}"`)
  const n = Number(m[1])
  const ms = m[2] === 'd' ? n * 86_400_000 : n * 3_600_000
  return BigInt(Date.now() - ms) * 1_000_000n
}

const rpc = async <T>(method: string, params: unknown): Promise<T> => {
  const res = await fetch(`${resolveViewerUrl()}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  })
  if (!res.ok) {
    throw new Error(`viewer RPC ${method} HTTP ${res.status}: ${await res.text()}`)
  }
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } }
  if (body.error) throw new Error(`viewer RPC ${method} error: ${body.error.message}`)
  return body.result as T
}

const fetchAllSpans = async (): Promise<Span[]> => {
  const summaries = await rpc<TraceSummary[]>('getTraceSummaries', {})
  const details = await Promise.all(
    summaries.map((s) => rpc<TraceDetail>('getTraceByID', [s.traceID]))
  )
  return details.flatMap((d) => d.spans.map((s) => s.spanData))
}

const attrStr = (attrs: Record<string, unknown>, key: string): string | undefined => {
  const v = attrs[key]
  return typeof v === 'string' ? v : undefined
}

const attrNum = (attrs: Record<string, unknown>, key: string): number => {
  const v = attrs[key]
  return typeof v === 'number' ? v : 0
}

const groupKey = (span: Span, by: StatsBy): string | undefined => {
  const a = span.attributes
  switch (by) {
    case 'provider':
      if (span.name !== 'gen_ai.dispatch_attempt') return undefined
      return attrStr(a, 'gen_ai.provider.name')
    case 'model':
      if (span.name !== 'gen_ai.dispatch_attempt') return undefined
      return attrStr(a, 'gen_ai.request.model')
    case 'session':
      return attrStr(a, 'gen_ai.conversation.id')
    case 'day': {
      if (span.name !== 'gen_ai.dispatch_attempt') return undefined
      const ms = Number(BigInt(span.startTime) / 1_000_000n)
      return new Date(ms).toISOString().slice(0, 10)
    }
  }
}

const aggregate = (spans: Span[], by: StatsBy, cutoff: bigint): StatsRow[] => {
  const buckets = new Map<string, StatsRow>()
  for (const span of spans) {
    if (BigInt(span.startTime) <= cutoff) continue
    const groupKeyValue = groupKey(span, by)
    if (groupKeyValue === undefined) continue
    const existing = buckets.get(groupKeyValue) ?? {
      key: groupKeyValue,
      requests: 0,
      cost_usd: 0,
      tokens_in: 0,
      tokens_out: 0
    }
    existing.requests += 1
    existing.cost_usd += attrNum(span.attributes, 'gen_ai.usage.cost_usd')
    existing.tokens_in =
      (existing.tokens_in ?? 0) + attrNum(span.attributes, 'gen_ai.usage.input_tokens')
    existing.tokens_out =
      (existing.tokens_out ?? 0) + attrNum(span.attributes, 'gen_ai.usage.output_tokens')
    buckets.set(groupKeyValue, existing)
  }
  return [...buckets.values()].sort((a, b) => b.cost_usd - a.cost_usd)
}

const COLS = ['key', 'requests', 'cost_usd', 'tokens_in', 'tokens_out'] as const

export const formatTable = (by: StatsBy, rows: StatsRow[]): string => {
  if (rows.length === 0) return '(no rows)'
  const header = COLS.map((c) => (c === 'key' ? by : c))
  const cells = rows.map((r) => COLS.map((c) => String(r[c] ?? '')))
  const widths = header.map((h, i) =>
    Math.max(h.length, ...cells.map((row) => (row[i] ?? '').length))
  )
  const fmtRow = (vals: string[]): string => vals.map((v, i) => v.padEnd(widths[i] ?? 0)).join('  ')
  return [fmtRow(header), fmtRow(widths.map((w) => '-'.repeat(w))), ...cells.map(fmtRow)].join('\n')
}

export const runStats = async (args: StatsArgs): Promise<StatsRow[]> => {
  const cutoff = sinceCutoffNanos(args.since)
  const spans = await fetchAllSpans()
  return aggregate(spans, args.by, cutoff)
}
