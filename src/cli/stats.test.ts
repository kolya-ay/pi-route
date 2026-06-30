import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { runStats } from './stats'

const originalFetch = globalThis.fetch

const summary = (traceID: string): Record<string, unknown> => ({
  traceID,
  rootSpan: {
    serviceName: 'pi-route',
    name: 'POST /v1/messages',
    startTime: String(BigInt(Date.now()) * 1_000_000n),
    endTime: String(BigInt(Date.now()) * 1_000_000n)
  },
  spanCount: 1
})

const traceWithSpans = (
  traceID: string,
  spans: { name: string; attributes: Record<string, unknown>; startTime?: string }[]
): Record<string, unknown> => ({
  traceID,
  spans: spans.map((s, i) => ({
    spanData: {
      traceID,
      spanID: `span${i}`,
      parentSpanID: '',
      name: s.name,
      attributes: s.attributes,
      startTime: s.startTime ?? String(BigInt(Date.now()) * 1_000_000n),
      endTime: String(BigInt(Date.now()) * 1_000_000n),
      statusCode: 'Unset'
    },
    depth: 0
  }))
})

type RpcReq = { method: string; params: unknown }

// Returns a fetch mock plus a `seen` accessor that records the last URL hit.
// Lets URL-resolution tests assert without closure-mutated `let` bindings.
const mockRpc = (
  handler: (req: RpcReq) => unknown
): { fetch: typeof fetch; seen: { url: string } } => {
  const seen = { url: '' }
  const fn = (async (url: string | URL, init?: RequestInit) => {
    seen.url = url.toString()
    const body = JSON.parse(String(init?.body ?? '{}')) as RpcReq & { id: number }
    const result = handler(body)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
  }) as typeof fetch
  return { fetch: fn, seen }
}

describe('runStats', () => {
  beforeEach(() => {
    delete process.env.PI_ROUTE_VIEWER_URL
    delete process.env.PI_ROUTE_VIEWER_PORT
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it.each([
    { env: { PI_ROUTE_VIEWER_PORT: '2020' }, expected: 'http://localhost:2020/rpc' },
    {
      env: { PI_ROUTE_VIEWER_URL: 'http://viewer.internal:9999', PI_ROUTE_VIEWER_PORT: '2020' },
      expected: 'http://viewer.internal:9999/rpc'
    },
    { env: {}, expected: 'http://localhost:8000/rpc' }
  ])('viewer URL resolves to $expected', async ({ env, expected }) => {
    Object.assign(process.env, env)
    const { fetch, seen } = mockRpc(() => [])
    globalThis.fetch = fetch
    await runStats({ by: 'provider', since: '7d' })
    expect(seen.url).toBe(expected)
  })

  it('aggregates spans by provider, sums cost, sorts by cost desc', async () => {
    const { fetch } = mockRpc((req) => {
      if (req.method === 'getTraceSummaries') return [summary('t1')]
      if (req.method === 'getTraceByID') {
        return traceWithSpans('t1', [
          {
            name: 'gen_ai.dispatch_attempt',
            attributes: {
              'gen_ai.provider.name': 'anthropic',
              'gen_ai.usage.cost_usd': 0.01,
              'gen_ai.usage.input_tokens': 100,
              'gen_ai.usage.output_tokens': 50
            }
          },
          {
            name: 'gen_ai.dispatch_attempt',
            attributes: {
              'gen_ai.provider.name': 'anthropic',
              'gen_ai.usage.cost_usd': 0.02,
              'gen_ai.usage.input_tokens': 200,
              'gen_ai.usage.output_tokens': 100
            }
          },
          {
            name: 'gen_ai.dispatch_attempt',
            attributes: {
              'gen_ai.provider.name': 'cerebras',
              'gen_ai.usage.cost_usd': 0.005,
              'gen_ai.usage.input_tokens': 50,
              'gen_ai.usage.output_tokens': 25
            }
          }
        ])
      }
      throw new Error(`unexpected method ${req.method}`)
    })
    globalThis.fetch = fetch
    const rows = await runStats({ by: 'provider', since: '7d' })
    expect(rows).toHaveLength(2)
    expect(rows[0]?.key).toBe('anthropic')
    expect(rows[0]?.requests).toBe(2)
    expect(rows[0]?.cost_usd).toBeCloseTo(0.03)
    expect(rows[1]?.key).toBe('cerebras')
  })

  it('by model groups by gen_ai.request.model on dispatch_attempt spans', async () => {
    const { fetch } = mockRpc((req) => {
      if (req.method === 'getTraceSummaries') return [summary('t1')]
      if (req.method === 'getTraceByID') {
        return traceWithSpans('t1', [
          {
            name: 'gen_ai.dispatch_attempt',
            attributes: {
              'gen_ai.request.model': 'claude-sonnet-4',
              'gen_ai.usage.cost_usd': 0.01
            }
          },
          {
            name: 'gen_ai.dispatch_attempt',
            attributes: {
              'gen_ai.request.model': 'claude-sonnet-4',
              'gen_ai.usage.cost_usd': 0.02
            }
          },
          {
            name: 'gen_ai.dispatch_attempt',
            attributes: {
              'gen_ai.request.model': 'gpt-5',
              'gen_ai.usage.cost_usd': 0.005
            }
          }
        ])
      }
      throw new Error(`unexpected method ${req.method}`)
    })
    globalThis.fetch = fetch
    const rows = await runStats({ by: 'model', since: '7d' })
    expect(rows).toHaveLength(2)
    expect(rows[0]?.key).toBe('claude-sonnet-4')
    expect(rows[0]?.requests).toBe(2)
    expect(rows[1]?.key).toBe('gpt-5')
    expect(rows[1]?.requests).toBe(1)
  })

  it('by day groups dispatch_attempt spans by ISO date bucket', async () => {
    const ns = (ms: number): string => String(BigInt(ms) * 1_000_000n)
    const noonUtcToday = (): number => {
      const d = new Date()
      d.setUTCHours(12, 0, 0, 0)
      return d.getTime()
    }
    const recentSummary = (traceID: string): Record<string, unknown> => ({
      ...summary(traceID),
      rootSpan: {
        serviceName: 'pi-route',
        name: 'POST /v1/messages',
        startTime: ns(Date.now()),
        endTime: ns(Date.now())
      }
    })
    const { fetch } = mockRpc((req) => {
      if (req.method === 'getTraceSummaries') return [recentSummary('t1')]
      if (req.method === 'getTraceByID') {
        return traceWithSpans('t1', [
          {
            name: 'gen_ai.dispatch_attempt',
            attributes: {
              'gen_ai.provider.name': 'anthropic',
              'gen_ai.usage.cost_usd': 0.01
            },
            // Anchor to today's noon UTC so offsets can't straddle midnight
            // regardless of when the suite runs: -1h/-2h stay on day A,
            // -25h lands solidly on day B. Avoids the ~1-min/day flake window
            // that Date.now()-based offsets would have around UTC midnight.
            startTime: ns(noonUtcToday() - 3_600_000) // day A, 11:00Z
          },
          {
            name: 'gen_ai.dispatch_attempt',
            attributes: {
              'gen_ai.provider.name': 'anthropic',
              'gen_ai.usage.cost_usd': 0.02
            },
            startTime: ns(noonUtcToday() - 7_200_000) // day A, 10:00Z
          },
          {
            name: 'gen_ai.dispatch_attempt',
            attributes: {
              'gen_ai.provider.name': 'anthropic',
              'gen_ai.usage.cost_usd': 0.005
            },
            startTime: ns(noonUtcToday() - 90_000_000) // day B (day prior), 11:00Z
          }
        ])
      }
      throw new Error(`unexpected method ${req.method}`)
    })
    globalThis.fetch = fetch
    const rows = await runStats({ by: 'day', since: '7d' })
    expect(rows).toHaveLength(2)
    // Each key should be an ISO date "YYYY-MM-DD"
    for (const r of rows) expect(r.key).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const totalRequests = rows.reduce((acc, r) => acc + r.requests, 0)
    expect(totalRequests).toBe(3)
  })

  it('by session groups by gen_ai.conversation.id regardless of span name', async () => {
    const { fetch } = mockRpc((req) => {
      if (req.method === 'getTraceSummaries') return [summary('t1')]
      if (req.method === 'getTraceByID') {
        return traceWithSpans('t1', [
          {
            name: 'POST /v1/messages',
            attributes: { 'gen_ai.conversation.id': 'sess-abc', 'gen_ai.usage.cost_usd': 0.001 }
          },
          {
            name: 'gen_ai.dispatch_attempt',
            attributes: { 'gen_ai.provider.name': 'anthropic' }
          }
        ])
      }
      throw new Error(`unexpected method ${req.method}`)
    })
    globalThis.fetch = fetch
    const rows = await runStats({ by: 'session', since: '7d' })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.key).toBe('sess-abc')
    expect(rows[0]?.requests).toBe(1)
    expect(rows[0]?.cost_usd).toBeCloseTo(0.001)
  })

  it('excludes spans older than --since window', async () => {
    const oldNs = String(BigInt(Date.now() - 10 * 86_400_000) * 1_000_000n)
    const { fetch } = mockRpc((req) => {
      if (req.method === 'getTraceSummaries') return [summary('t1')]
      if (req.method === 'getTraceByID') {
        return traceWithSpans('t1', [
          {
            name: 'gen_ai.dispatch_attempt',
            attributes: { 'gen_ai.provider.name': 'anthropic', 'gen_ai.usage.cost_usd': 0.5 },
            startTime: oldNs
          },
          {
            name: 'gen_ai.dispatch_attempt',
            attributes: { 'gen_ai.provider.name': 'anthropic', 'gen_ai.usage.cost_usd': 0.1 }
          }
        ])
      }
      throw new Error(`unexpected method ${req.method}`)
    })
    globalThis.fetch = fetch
    const rows = await runStats({ by: 'provider', since: '7d' })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.requests).toBe(1)
    expect(rows[0]?.cost_usd).toBeCloseTo(0.1)
  })

  it('returns empty array when no traces exist', async () => {
    const { fetch } = mockRpc(() => [])
    globalThis.fetch = fetch
    const rows = await runStats({ by: 'provider', since: '7d' })
    expect(rows).toEqual([])
  })

  it('throws when RPC returns an error envelope', async () => {
    globalThis.fetch = (async (_input: Request | string | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -1, message: 'boom' }
        })
      )) as typeof fetch
    await expect(runStats({ by: 'provider', since: '7d' })).rejects.toThrow(/boom/)
  })

  it('throws when HTTP status is not ok', async () => {
    globalThis.fetch = (async (_input: Request | string | URL, _init?: RequestInit) =>
      new Response('upstream broken', { status: 500 })) as typeof fetch
    await expect(runStats({ by: 'provider', since: '7d' })).rejects.toThrow(/500/)
  })
})
